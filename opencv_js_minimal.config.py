# OpenCV.js minimal build for PaddleOCR frontend
#
# Target:
#   paddleocr-js
#
# OpenCV:
#   4.x
#
# Modules:
#   core
#   imgproc


# ==========================
# core
# ==========================

core = {

    '': [

        # matrix calculation

        'mean',

        'split',
        'merge',

        'add',
        'subtract',
        'multiply',

        'normalize',

        'convertScaleAbs',


        # bit operation

        'bitwise_and',
        'bitwise_or',
        'bitwise_not',


        # image

        'copyMakeBorder',

        'inRange',


        # rotate

        'rotate',

    ],


    # JS classes

    'Mat': [],

    'MatVector': [],

    'Scalar': [],

    'Size': [],

    'Rect': [],

    'RotatedRect': [],

}



# ==========================
# imgproc
# ==========================

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


        # geometry

        'minAreaRect',


        # perspective

        'getPerspectiveTransform',

        'warpPerspective',


        # polygon

        'fillPoly',

        'polylines',


        # rotate

        'getRotationMatrix2D',

        'warpAffine',


        # filter

        'GaussianBlur',

    ]

}



# ==========================
# OpenCV constants
# ==========================

enums = [

    # border

    'BORDER_REPLICATE',


    # contour

    'CHAIN_APPROX_SIMPLE',

    'RETR_LIST',


    # color

    'COLOR_GRAY2BGR',

    'COLOR_RGBA2BGR',


    # interpolation

    'INTER_LINEAR',

    'INTER_CUBIC',


    # rotation

    'ROTATE_90_COUNTERCLOCKWISE',


    # Mat type

    'CV_8UC1',

    'CV_32FC1',

    'CV_32FC2',

    'CV_32SC2',

]



# ==========================
# generate whitelist
# ==========================

white_list = makeWhiteList(
    [
        core,
        imgproc,
    ]
)


white_list += enums
