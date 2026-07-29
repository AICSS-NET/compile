#!/usr/bin/env node

const fs=require("fs");


const NEEDED=[

"cvtColor",

"resize",

"findContours",

"minAreaRect",

"getPerspectiveTransform",

"warpPerspective",

"fillPoly",

"rotate",

"mean",


"Mat",

"MatVector",

"RotatedRect",

"Rect",

"Size",

"Scalar",

];


const file=process.argv[2];


if(!file){

 console.error(
 "node verify_opencv_build.js opencv.js"
 );

 process.exit(2);

}


const data=fs.readFileSync(file,"utf8");


const missing=NEEDED.filter(
 x=>!data.includes(x)
);


console.log(
`检查文件: ${file}`
);


console.log(
`需要: ${NEEDED.length}`
);


console.log(
`缺失: ${missing.length}`
);


if(missing.length){

 console.error(
 "\n❌ missing:"
 );

 missing.forEach(
 x=>console.error(x)
 );

 process.exit(1);

}


console.log(
"\n✅ OpenCV.js OK"
);
