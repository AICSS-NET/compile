#!/usr/bin/env node
// 校验编译出来的 opencv.js + opencv_js.wasm 是否包含 paddleocr-js 实际会调用到
// 的全部函数/常量。这份清单是从 paddleocr-js@0.4.2 的 index.mjs 里反编译提取
// 出来的真实调用列表（见对话记录里的 grep 'cv\.([A-Za-z_]+)' 结果），不是随便列的。
//
// 重要：因为构建用了 --disable_single_file，wasm 是独立文件，embind 的函数/
// 常量"名字"这些字符串实际存放在 .wasm 二进制的数据段里（JS 侧的胶水代码在
// Module 初始化时读取这些名字，动态构造出 Module.findContours 这些属性），
// 不在 opencv.js/opencv_js.js 这两个 .js 文本文件里。只检查 .js 文件会产生
//大量假阳性的"缺失"——这是这份脚本第一版的真实 bug，在此更正：两个文件都要查。
//
// 用法：node verify_opencv_build.js <opencv.js的路径> <opencv_js.wasm的路径>
// 少任何一项，都会以非 0 退出码结束——配合 GitHub Actions，能让"编译产物
// 真的缺函数"这种情况把 workflow 判定为失败，不会静默放过。

const fs = require("fs");

const NEEDED = [
  // 函数 / 类
  "imread", "cvtColor", "resize", "findContours", "minAreaRect", "RotatedRect",
  "getPerspectiveTransform", "warpPerspective", "matFromArray", "Mat", "MatVector",
  "Rect", "Size", "Scalar", "fillPoly", "rotate", "mean",
  // 枚举常量
  "BORDER_REPLICATE", "CHAIN_APPROX_SIMPLE", "COLOR_GRAY2BGR", "COLOR_RGBA2BGR",
  "CV_32FC1", "CV_32FC2", "CV_32SC2", "CV_8UC1", "INTER_CUBIC", "INTER_LINEAR",
  "RETR_LIST", "ROTATE_90_COUNTERCLOCKWISE",
];

const jsPath = process.argv[2];
const wasmPath = process.argv[3];
if (!jsPath || !wasmPath) {
  console.error("用法: node verify_opencv_build.js <opencv.js的路径> <opencv_js.wasm的路径>");
  process.exit(2);
}

// .js 用文本方式读，.wasm 用二进制方式读，把两边的内容分别转成可以用
// includes() 搜索的字符串，只要任意一边包含目标名字就算找到。
const jsText = fs.readFileSync(jsPath, "utf8");
const wasmText = fs.readFileSync(wasmPath).toString("latin1"); // latin1 保留原始字节，不做UTF-8校验/替换

const missing = NEEDED.filter((name) => !jsText.includes(name) && !wasmText.includes(name));

console.log(`检查文件: ${jsPath} + ${wasmPath}`);
console.log(`需要的函数/常量总数: ${NEEDED.length}`);
console.log(`缺失: ${missing.length}`);

if (missing.length > 0) {
  console.error("\n❌ 以下函数/常量在编译产物里没有找到，构建产物不完整，不能使用：");
  missing.forEach((name) => console.error("  - " + name));
  process.exit(1);
}

console.log("\n✅ 全部函数/常量都在，构建产物完整。");

