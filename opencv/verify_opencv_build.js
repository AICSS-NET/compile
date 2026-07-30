#!/usr/bin/env node
// 校验编译出来的 opencv.js（单文件模式，wasm 以 base64 内嵌）是否包含
// paddleocr-js 实际会调用到的全部函数/常量。这份清单是从 paddleocr-js@0.4.2
// 的 index.mjs 里反编译提取出来的真实调用列表（见对话记录里的
// grep 'cv\.([A-Za-z_]+)' 结果），不是随便列的。
//
// 重要：embind 的函数/常量"名字"这些字符串，实际存放在 wasm 二进制的数据段
// 里（JS 侧胶水代码在 Module 初始化时读取这些名字，动态构造出
// Module.findContours 这些属性）。单文件模式下 wasm 是以
// "data:application/octet-stream;base64,...." 这种 data URI 整个塞进
// opencv.js 里的，base64 编码会打乱字节对齐，直接对 .js 文本做字符串搜索是
// 找不到这些名字的（第一版脚本就是栽在这——当时用的是分离文件模式，只查了
// .js 没查独立的 .wasm 文件，一样会漏）。这一版会自动识别、提取 opencv.js
// 里的 base64 data URI 并解码回原始二进制再搜索，不需要额外参数区分单文件/
// 分离文件两种模式。
//
// 用法：node verify_opencv_build.js <opencv.js的路径> [opencv_js.wasm的路径]
//   - 只传一个参数：按单文件模式处理，自动从 opencv.js 里提取内嵌的 wasm。
//   - 传两个参数：按分离文件模式处理（如果以后又改回 --disable_single_file）。
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
const wasmPath = process.argv[3]; // 可选，分离文件模式才会传

if (!jsPath) {
  console.error("用法: node verify_opencv_build.js <opencv.js的路径> [opencv_js.wasm的路径]");
  process.exit(2);
}

const jsText = fs.readFileSync(jsPath, "utf8");

// 搜索范围：opencv.js 文本本身 + (分离文件模式下的 .wasm 二进制 | 单文件模式下
// 从 opencv.js 内嵌的 base64 data URI 解码出来的二进制)，latin1 编码保留原始
// 字节，不做 UTF-8 校验/替换，避免把非法字节丢失导致搜索遗漏。
let binaryText = "";

if (wasmPath) {
  console.log(`模式：分离文件（.js + .wasm）`);
  binaryText = fs.readFileSync(wasmPath).toString("latin1");
} else {
  const m = jsText.match(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/);
  if (m) {
    console.log(`模式：单文件（wasm 以 base64 内嵌），提取到 base64 长度 ${m[1].length}`);
    binaryText = Buffer.from(m[1], "base64").toString("latin1");
    console.log(`解码后二进制大小: ${binaryText.length} 字节`);
  } else {
    console.log("模式：单文件，但没有在 opencv.js 里找到 base64 data URI —— " +
      "可能确实是单文件但编码方式不是 base64（少见），或者本身就没内嵌 wasm。" +
      "继续只用 opencv.js 文本本身搜索，可能会有假阳性缺失，请留意。");
  }
}

const missing = NEEDED.filter((name) => !jsText.includes(name) && !binaryText.includes(name));

console.log(`\n检查文件: ${jsPath}${wasmPath ? " + " + wasmPath : ""}`);
console.log(`需要的函数/常量总数: ${NEEDED.length}`);
console.log(`缺失: ${missing.length}`);

if (missing.length > 0) {
  console.error("\n❌ 以下函数/常量在编译产物里没有找到，构建产物不完整，不能使用：");
  missing.forEach((name) => console.error("  - " + name));
  process.exit(1);
}

console.log("\n✅ 全部函数/常量都在，构建产物完整。");
