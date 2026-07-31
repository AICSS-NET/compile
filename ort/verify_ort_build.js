#!/usr/bin/env node
// 真正的"能不能用"校验：不是查字符串在不在（那种查法已经在 opencv 那次证明
// 不可靠——base64/wasm二进制里的字符串排布跟直觉不一样，容易假阳性/假阴性），
// 而是拿官方的 onnxruntime-web JS 包装层（ort.wasm.min.mjs，跟线上 index.html
// 里 importmap 用的是同一个版本），配上这次新编译出来的精简版
// ort-wasm-simd-threaded.mjs/.wasm，去真实加载 PP-OCR 模型文件、
// 各自跑一次推理——这是在验证"官方 JS 包装层 + 我们自己编译的底层 wasm"
// 这套组合本身是否真的可行，而不是停留在理论推导。
//
// 用法：node verify_ort_build.js <新编译出来的 dist 目录> <模型所在目录（会递归找 .onnx）>

const fs = require("fs");
const path = require("path");

const distDir = process.argv[2];
const modelsDir = process.argv[3];

if (!distDir || !modelsDir) {
  console.error("用法: node verify_ort_build.js <dist目录> <模型目录>");
  process.exit(2);
}

function findOnnxFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findOnnxFiles(full));
    else if (entry.name.endsWith(".onnx")) results.push(full);
  }
  return results;
}

// 把 ONNX 里可能出现的动态维度（null / 字符串占位符，比如 "batch_size"、"width"）
// 换成一个较小的固定数字，方便直接喂进去跑一次前向推理，不需要真实图片。
function concretizeDims(dims, fallback = 32) {
  return dims.map((d) => (typeof d === "number" && d > 0 ? d : fallback));
}

(async () => {
  // 直接 require 我们通过 npm install 拿到的官方包里的 wasm 版本入口文件，
  // 避免 package.json 的 exports 条件把我们导到 onnxruntime-node 之类的
  // 其它构建上去。
  const ortEntry = path.join(
    process.cwd(), "node_modules", "onnxruntime-web", "dist", "ort.wasm.min.mjs"
  );
  const ort = await import("file://" + ortEntry);

  // 指向这次新编译出来的 wasm/mjs（同目录下应该有 ort-wasm-simd-threaded.mjs
  // 和 ort-wasm-simd-threaded.wasm 这一对文件）。
  // 必须转成绝对路径：命令行传进来的 distDir 可能是 "dist" 这种相对路径，
  // onnxruntime-web 内部会用动态 import() 去加载 wasm 伴生文件，而 Node 的
  // ESM 加载器对不带 "./" 前缀的相对路径字符串，会当成 npm 包名去
  // node_modules 里找——"dist" 找不到对应的包，就会报
  // "Cannot find package 'dist'"（这个坑之前也在浏览器端的
  // window.__OCR_VENDOR_BASE__ 上踩过一次，是同一类问题，这次换成 Node
  // 环境又踩了一遍）。转成绝对路径之后就没有这个歧义了。
  const absDistDir = path.resolve(distDir);
  ort.env.wasm.wasmPaths = absDistDir.endsWith(path.sep) ? absDistDir : absDistDir + path.sep;
  // 跟 ocr-app.js 里 CONFIG.ortBackend 保持一致：固定纯 CPU wasm，不走 WebGPU。
  ort.env.wasm.numThreads = 1;

  const onnxFiles = findOnnxFiles(modelsDir);
  if (onnxFiles.length === 0) {
    console.error("❌ 在", modelsDir, "下没找到任何 .onnx 文件，检查上一步模型下载/解压是否正常。");
    process.exit(1);
  }
  console.log(`找到 ${onnxFiles.length} 个模型文件，逐个加载+推理测试：`);

  let anyFailed = false;

  for (const modelPath of onnxFiles) {
    const modelName = path.relative(modelsDir, modelPath);
    console.log(`\n--- ${modelName} ---`);
    try {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["wasm"],
      });

      const feeds = {};
      for (const name of session.inputNames) {
        // inputMetadata 在较新的 onnxruntime-web 里可用；拿不到就退回一个
        // 通用的 [1,3,64,64]（NCHW 图片输入的常见形状），仍然能测出"这个
        // 模型能不能被底层 wasm 正确执行"，只是万一形状完全对不上，推理会
        // 报形状错误而不是算子缺失错误——下面会分别处理、给出清晰提示。
        let dims = [1, 3, 64, 64];
        try {
          const meta = session.inputMetadata?.find((m) => m.name === name);
          if (meta?.shape) dims = concretizeDims(meta.shape);
        } catch (_) {
          /* 拿不到就用默认形状 */
        }
        const size = dims.reduce((a, b) => a * b, 1);
        feeds[name] = new ort.Tensor("float32", new Float32Array(size).fill(0.5), dims);
        console.log(`  输入 ${name}: 形状 [${dims.join(",")}]`);
      }

      const results = await session.run(feeds);
      const outNames = Object.keys(results);
      console.log(`  ✅ 推理成功，输出: ${outNames.join(", ")}`);
    } catch (err) {
      anyFailed = true;
      console.error(`  ❌ 失败: ${err.message}`);
      if (/not implemented|not supported|no kernel|not found/i.test(err.message)) {
        console.error("     看起来像是算子精简裁过头了——某个这个模型需要的算子" +
          "没有被包含进精简清单，需要检查 ops_config.txt 生成步骤是否真的覆盖到了这个模型。");
      }
    }
  }

  if (anyFailed) {
    console.error("\n❌ 至少一个模型推理失败，这次编译出来的精简版 wasm 不能用，不应该被当成正常产物发布。");
    process.exit(1);
  }
  console.log(`\n✅ 全部 ${onnxFiles.length} 个模型都能正常加载并完成推理，精简版 wasm 可用。`);
})().catch((err) => {
  console.error("脚本本身出错:", err);
  process.exit(1);
});
