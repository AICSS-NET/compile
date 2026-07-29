# 精简版 opencv.js 构建配置（只含 core + imgproc）

这个文件夹是给 GitHub Actions 用的，能自动编译出一个只包含 `core` + `imgproc`
两个模块的定制版 `opencv.js`，去掉了 `@techstark/opencv-js` 官方版里用不到的
视频处理、机器学习、特征点检测、相机标定等模块。

**预期效果**：官方版 `opencv.js` 是 10.3MB 单文件；这个精简版实测（在旧版
Emscripten 下）产出 `opencv.js`（约 153KB）+ `opencv_js.wasm`（约 2.8MB），
合计约 2.9MB，**减少约 72%**。

## 怎么用

1. 建一个新的 GitHub 仓库（私有公有都行），把这个文件夹（`.github/workflows/build-opencv-js.yml`、
   `opencv_js_minimal.config.py`、`verify_opencv_build.js`）整个传上去，保持这个目录结构。
2. 打开仓库的 Actions 页面，找到 "Build minimal opencv.js" 这个 workflow，点右边的
   "Run workflow" 手动触发一次。
3. 等个十几分钟（GitHub 官方 runner 是 4 核，比我在沙盒环境里那台 1 核的机器快很多），
   构建成功后，在这次运行的页面最下面 "Artifacts" 那块，能下载到一个叫
   `opencv-js-minimal` 的压缩包，里面就是 `opencv.js` + `opencv_js.wasm` 两个文件。
4. 把这两个文件放进你 OCR 工具的 `vendor/` 目录，替换掉原来 10.3MB 的那个
   `opencv.js`（`opencv_js.wasm` 是新增的，要一起放进去，两个文件必须在同一个目录下，
   `opencv.js` 内部是通过"当前脚本所在目录"去找 `opencv_js.wasm` 的）。index.html/ocr-app.js
   那边的引用路径不用改，文件名对得上就行。

## 如果 workflow 跑失败了

workflow 里有一步专门做"产物完整性校验"（`verify_opencv_build.js`），如果编译出来的
`opencv.js` 缺少 `findContours`/`minAreaRect`/`warpPerspective` 等任何一个我们实际会
用到的函数，这一步会让整个 workflow 直接标红失败，不会让一个"看起来编译成功、实际
缺函数"的半成品被当成正常产物发布出来——这是我在沙盒环境里实测踩过的坑（旧版本
Emscripten 下，编译"成功"了，但产物里缺了近一半需要的函数，具体原因没查清楚，怀疑
是那个老版本工具链的 bug）。

如果换了 GitHub Actions 用的最新版 Emscripten 之后，这一步还是失败：把失败日志里
"缺失"的函数名列表发给我，我再帮你往下查——大概率还是某个 embind 绑定生成的兼容性
问题，需要针对性调整 `opencv_js_minimal.config.py`。

## 这个配置文件是怎么来的

`opencv_js_minimal.config.py` 改自 OpenCV 官方仓库
`platforms/js/opencv_js.config.py`，唯一的改动是最后一行：

```python
white_list = makeWhiteList([core, imgproc])
```

原始官方文件这一行是 `makeWhiteList([core, imgproc, objdetect, video, dnn, features2d, photo, calib3d])`，
砍掉了 `objdetect`（人脸/物体检测）、`video`（视频跟踪）、`dnn`（深度学习）、
`features2d`（特征点检测）、`photo`（图像修复/降噪）、`calib3d`（相机标定）这 6 个
模块——这些都是 `paddleocr-js` 用不到的功能。`core` + `imgproc` 这两个模块保持
官方原样一个字没动，包含了 `findContours`/`minAreaRect`/`warpPerspective` 等
OCR 检测后处理需要的全部函数，不会有漏的。
