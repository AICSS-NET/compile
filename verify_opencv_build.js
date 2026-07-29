#!/usr/bin/env node


const fs = require("fs");



const NEEDED = [

    // functions

    "cvtColor",

    "resize",

    "findContours",

    "minAreaRect",

    "getPerspectiveTransform",

    "warpPerspective",

    "fillPoly",

    "rotate",

    "mean",



    // classes

    "Mat",

    "MatVector",

    "RotatedRect",

    "Rect",

    "Size",

    "Scalar",



    // constants

    "BORDER_REPLICATE",

    "CHAIN_APPROX_SIMPLE",

    "COLOR_GRAY2BGR",

    "COLOR_RGBA2BGR",

    "CV_8UC1",

    "CV_32FC1",

    "CV_32FC2",

    "CV_32SC2",

    "INTER_LINEAR",

    "INTER_CUBIC",

    "RETR_LIST",

    "ROTATE_90_COUNTERCLOCKWISE",

];



const filePath = process.argv[2];


if (!filePath) {

    console.error(
        "Usage: node verify_opencv_build.js <opencv.js>"
    );

    process.exit(2);

}



const content = fs.readFileSync(
    filePath,
    "utf8"
);



const missing = NEEDED.filter(
    item => !content.includes(item)
);



console.log(
    `检查文件: ${filePath}`
);


console.log(
    `需要的函数/常量总数: ${NEEDED.length}`
);


console.log(
    `缺失: ${missing.length}`
);



if (missing.length > 0) {


    console.error(
        "\n❌ OpenCV.js 缺少 PaddleOCR 必需 API:"
    );


    missing.forEach(
        item =>
            console.error(
                " - " + item
            )
    );


    process.exit(1);

}



console.log(
    "\n✅ OpenCV.js 满足 PaddleOCR 前端需求"
);
