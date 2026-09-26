#!/usr/bin/env node
/**
 * 把 pdf.worker.min.mjs 的源码以字符串字面量（JSON.stringify 转义，而不是
 * base64）内嵌进主文件末尾，追加一段在浏览器里运行的代码：用 Blob +
 * URL.createObjectURL 生成一个本地 blob: URL，交给
 * pdfjsLib.GlobalWorkerOptions.workerSrc。
 *
 * 相比 base64 data: URI 方案：
 *   - 体积更小：JSON.stringify 只转义特殊字符（引号、反斜杠、控制字符），
 *     不是像 base64 那样整体 4/3 膨胀。
 *   - 兼容性更好：blob: URL 作为 module worker（{type:"module"}）的加载
 *     方式，比 data: URI 更稳妥——部分旧版本浏览器对 "new Worker(dataURL,
 *     {type:'module'})" 支持不一致，blob: 支持得更早、更一致。
 *   - 全程不发任何网络请求，Blob 是纯本地对象，离线环境一样可用。
 *
 * 注意：这里只是在构建阶段（Node.js）把 worker 源码写成字符串字面量存进
 * 文件；真正调用 `new Blob(...)` / `URL.createObjectURL(...)` 的代码是
 * 追加进去、之后在浏览器里执行的，Node.js 环境本身没有 Blob/URL 全局对象
 * 也没关系，构建脚本自己不会去执行那段代码。
 *
 * 用法：node embed-pdfjs-worker.mjs <主文件路径> <worker文件路径> <输出文件路径>
 */
import fs from "fs";

const [, , mainPath, workerPath, outPath] = process.argv;

if (!mainPath || !workerPath || !outPath) {
  console.error(
    "用法: node embed-pdfjs-worker.mjs <主文件路径> <worker文件路径> <输出文件路径>"
  );
  process.exit(1);
}

const mainCode = fs.readFileSync(mainPath, "utf8");
const workerCode = fs.readFileSync(workerPath, "utf8");

// JSON.stringify 生成的是合法的 JS 字符串字面量，能安全处理 worker 代码里
// 出现的引号、反斜杠、换行等任意内容，不需要再手写转义规则。
const snippet = `
(function () {
  var workerCode = ${JSON.stringify(workerCode)};
  var blob = new Blob([workerCode], { type: "text/javascript" });
  var url = URL.createObjectURL(blob);
  if (typeof window !== "undefined" && window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = url;
  }
})();
`;

fs.writeFileSync(outPath, mainCode + snippet);

const beforeSize = Buffer.byteLength(mainCode, "utf8");
const afterSize = Buffer.byteLength(mainCode + snippet, "utf8");
console.log(
  `[embed-pdfjs-worker] 主文件 ${beforeSize} 字节 + worker(${workerCode.length} 字符，Blob 方案) ` +
    `→ 输出 ${outPath}，共 ${afterSize} 字节`
);
