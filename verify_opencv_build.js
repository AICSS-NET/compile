#!/usr/bin/env node
// 校验编译出来的 opencv.js 是否包含 paddleocr-js 实际会调用到的全部函数/常量。
// 这份清单是从 paddleocr-js@0.4.2 的 index.mjs 里反编译提取出来的真实调用列表
// （见对话记录里的 grep 'cv\.([A-Za-z_]+)' 结果），不是随便列的。
//
// 用法：node verify_opencv_build.js <opencv.js的路径>
// 少任何一项，都会以非 0 退出码结束——配合 GitHub Actions，能让"编译成功
// 但产物实际缺函数"这种情况直接把 workflow 判定为失败，不会静默放过。

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

const filePath = process.argv[2];
if (!filePath) {
  console.error("用法: node verify_opencv_build.js <opencv.js的路径>");
  process.exit(2);
}

const data = fs.readFileSync(filePath, "utf8");
const missing = NEEDED.filter((name) => !data.includes(name));

console.log(`检查文件: ${filePath}`);
console.log(`需要的函数/常量总数: ${NEEDED.length}`);
console.log(`缺失: ${missing.length}`);

if (missing.length > 0) {
  console.error("\n❌ 以下函数/常量在编译产物里没有找到，构建产物不完整，不能使用：");
  missing.forEach((name) => console.error("  - " + name));
  process.exit(1);
}

console.log("\n✅ 全部函数/常量都在，构建产物完整。");
