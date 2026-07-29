# OpenCV.js minimal config
# PaddleOCR frontend


core = {

    '': [

        # matrix

        'mean',

        'split',

        'merge',

        'add',

        'subtract',

        'multiply',

        'normalize',


        # image

        'convertScaleAbs',

        'copyMakeBorder',

        'inRange',


        # bit

        'bitwise_and',

        'bitwise_or',

        'bitwise_not',


        # rotate

        'rotate',

    ]

}



imgproc = {

    '': [

        # color

        'cvtColor',


        # resize

        'resize',


        # threshold

        'threshold',

        'adaptiveThreshold',


        # contour

        'findContours',

        'drawContours',

        'approxPolyDP',

        'arcLength',

        'contourArea',


        # rectangle

        'minAreaRect',


        # perspective

        'getPerspectiveTransform',

        'warpPerspective',


        # polygon

        'fillPoly',

        'polylines',


        # affine

        'getRotationMatrix2D',

        'warpAffine',


        # filter

        'GaussianBlur',

    ]

}



# required enum

enums = [

    'BORDER_REPLICATE',

    'CHAIN_APPROX_SIMPLE',

    'COLOR_GRAY2BGR',

    'COLOR_RGBA2BGR',

    'CV_8UC1',

    'CV_32FC1',

    'CV_32FC2',

    'CV_32SC2',

    'INTER_LINEAR',

    'INTER_CUBIC',

    'RETR_LIST',

    'ROTATE_90_COUNTERCLOCKWISE',

]



white_list = makeWhiteList(

    [

        core,

        imgproc,

    ]

)



white_list += enums
