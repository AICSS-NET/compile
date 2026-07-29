# OpenCV.js minimal build
# PaddleOCR frontend


core = {

    '': [

        'mean',

        'split',
        'merge',

        'add',
        'subtract',
        'multiply',

        'normalize',

        'convertScaleAbs',

        'copyMakeBorder',

        'inRange',

        'rotate',

    ]

}



imgproc = {

    '': [

        'cvtColor',

        'resize',


        'threshold',

        'adaptiveThreshold',


        'findContours',

        'drawContours',

        'approxPolyDP',

        'arcLength',

        'contourArea',


        'minAreaRect',


        'getPerspectiveTransform',

        'warpPerspective',


        'fillPoly',

        'polylines',


        'getRotationMatrix2D',

        'warpAffine',


        'GaussianBlur',

    ]

}



white_list = makeWhiteList(
    [
        core,
        imgproc
    ]
)
