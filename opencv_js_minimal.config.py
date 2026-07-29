# OpenCV.js minimal whitelist for PaddleOCR frontend
#
# Target:
#   paddleocr-js frontend OCR
#
# Keep:
#   core + imgproc + required JS bindings
#
# Remove:
#   dnn
#   video
#   objdetect
#   features2d
#   photo
#   calib3d


# =========================
# core
# =========================

core = {

    '': [

        # math
        'mean',

        # matrix operation
        'split',
        'merge',
        'add',
        'subtract',
        'multiply',
        'normalize',

        # image operation
        'bitwise_and',
        'bitwise_or',
        'bitwise_not',

        'convertScaleAbs',

        # border
        'copyMakeBorder',

        # range
        'inRange',

        # rotate
        'rotate',
    ],


    # JS classes

    'Mat': [
        'Mat',
        'clone',
        'copyTo',
        'convertTo',
        'roi',
        'size',
        'type',
    ],


    'MatVector': [
        'MatVector',
        'size',
        'get',
        'push_back',
    ],


    'Scalar': [],

    'Size': [],

    'Rect': [],


    'RotatedRect': [
        'points',
        'boundingRect',
    ],
}



# =========================
# imgproc
# =========================

imgproc = {

    '': [

        # color
        'cvtColor',


        # resize
        'resize',


        # threshold
        'threshold',
        'adaptiveThreshold',


        # contour detection
        'findContours',
        'drawContours',
        'approxPolyDP',
        'arcLength',
        'contourArea',


        # box
        'minAreaRect',


        # perspective transform
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



# =========================
# enum constants
# =========================

enums = [

    # Border
    'BORDER_REPLICATE',


    # Contours
    'CHAIN_APPROX_SIMPLE',
    'RETR_LIST',


    # Color
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



# =========================
# generate whitelist
# =========================

white_list = makeWhiteList(
    [
        core,
        imgproc,
    ]
)


# add enums
white_list += enums
