#!/usr/bin/env node

// Verify minimal OpenCV.js build for paddleocr-js


const fs = require("fs");


const NEEDED = [

    // classes/functions

    "cvtColor",
    "resize",

    "findContours",
    "minAreaRect",

    "RotatedRect",

    "getPerspectiveTransform",
    "warpPerspective",

    "Mat",
    "MatVector",

    "Rect",
    "Size",
    "Scalar",

    "fillPoly",

    "rotate",

    "mean",



    // enums

    "BORDER_REPLICATE",

    "CHAIN_APPROX_SIMPLE",

    "COLOR_GRAY2BGR",
    "COLOR_RGBA2BGR",

    "CV_32FC1",
    "CV_32FC2",
    "CV_32SC2",

    "CV_8UC1",

    "INTER_CUBIC",
    "INTER_LINEAR",

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



const data = fs.readFileSync(
    filePath,
    "utf8"
);



const missing = NEEDED.filter(
    name => !data.includes(name)
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
        "\n❌ OpenCV.js缺少以下API:"
    );


    missing.forEach(
        name =>
            console.error(
                "  - " + name
            )
    );


    process.exit(1);

}



console.log(
    "\n✅ PaddleOCR需要的OpenCV API全部存在"
);
