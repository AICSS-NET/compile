#!/usr/bin/env python3
"""
在 convert_onnx_models_to_ort.py 自动生成的算子清单基础上，补充一大批标准
CNN/序列模型算子——不管自动扫描（静态分析优化后的图）有没有漏掉它们，都强制
确保这些算子在清单里。

背景：自动扫描连续几轮分别漏了 Relu、HardSigmoid、Div 这几个非常基础的算子，
不是偶然漏一两个边缘算子，是对这两个真实 PP-OCR 模型的自动覆盖本来就不够
完整（具体是自动扫描哪个环节漏的，没有拿到真实模型文件在本地复现出来，没能
百分百查清楚）。与其继续一轮 workflow 才发现"还差一个"、来回耗时排查，这次
直接把安全网扩得足够大，覆盖典型 CNN + 序列模型会用到的绝大多数标准算子，
一次性堵上，接受"编译产物可能比理论最小体积略大一点"的代价换稳定性。

用法：python3 patch_ops_config.py <required_operators.config的路径>
"""

import re
import sys

# 常见的 CNN / 序列模型算子，强制确保包含在清单里。
#
# 背景：自动扫描（convert_onnx_models_to_ort.py）连续几轮分别漏了
# Relu、HardSigmoid、Div 这几个非常基础的算子——不是偶然漏掉一两个边缘算子，
# 是对这两个真实模型的自动覆盖本来就不够完整。与其继续一轮跑一次 workflow
# 才发现"还差一个"、来回耗时，这次直接把安全网扩得足够大，覆盖典型 CNN +
# 序列模型（PP-OCR 的识别模型部分用到 CTC/序列解码，可能涉及 LSTM/GRU 之类）
# 会用到的绝大多数标准算子，一次性堵上，接受"可能比理论最小体积略大一点"的
# 代价换稳定性。
SAFETY_NET_OPS = {
    # 基础算术
    "Add", "Sub", "Mul", "Div", "Pow", "Sqrt", "Exp", "Log", "Neg", "Abs",
    "Reciprocal", "Sum", "Mean", "Min", "Max", "Clip", "Sign", "Floor", "Ceil",
    "Round", "Erf", "CumSum",
    # 激活函数
    "Relu", "Sigmoid", "HardSigmoid", "HardSwish", "Tanh", "LeakyRelu", "PRelu",
    "Softmax", "LogSoftmax", "Elu", "Selu", "Softplus", "Softsign", "Mish", "Gelu",
    # 卷积/池化/归一化
    "Conv", "ConvTranspose", "MaxPool", "AveragePool", "GlobalAveragePool",
    "GlobalMaxPool", "BatchNormalization", "InstanceNormalization", "LRN", "Dropout",
    # 形状/张量操作
    "Reshape", "Transpose", "Concat", "Split", "Slice", "Squeeze", "Unsqueeze",
    "Flatten", "Expand", "Tile", "Pad", "Gather", "GatherElements", "GatherND",
    "Scatter", "ScatterElements", "ScatterND", "Shape", "Size", "Cast",
    "ConstantOfShape", "Constant", "Identity", "Where", "Range",
    # 归约/排序
    "ReduceMean", "ReduceSum", "ReduceMax", "ReduceMin", "ReduceProd",
    "ArgMax", "ArgMin", "TopK",
    # 比较/逻辑
    "Equal", "Greater", "Less", "GreaterOrEqual", "LessOrEqual", "And", "Or",
    "Not", "Xor",
    # 矩阵运算
    "MatMul", "Gemm",
    # 序列模型（识别模型的 CTC/序列解码部分可能用到）
    "LSTM", "GRU", "RNN",
    # 视觉常用
    "Resize", "Upsample", "NonMaxSuppression",
    # 三角函数（部分位置编码/注意力机制会用到）
    "Sin", "Cos",
}

LINE_PATTERN = re.compile(r"^(ai\.onnx);([\d,]+);(.+)$")


def main():
    if len(sys.argv) != 2:
        print("用法: python3 patch_ops_config.py <required_operators.config的路径>", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()

    out_lines = []
    patched_any = False
    seen_ai_onnx_opset = False

    for line in lines:
        stripped = line.rstrip("\n")
        m = LINE_PATTERN.match(stripped)
        if m:
            seen_ai_onnx_opset = True
            domain, opset_str, ops_str = m.groups()
            # 只处理没有类型信息（不含"{"）的简单算子列表，带类型信息的行不动，
            # 避免破坏 JSON 类型标注的格式。
            if "{" not in ops_str:
                existing_ops = {op.strip() for op in ops_str.split(",") if op.strip()}
                merged_ops = existing_ops | SAFETY_NET_OPS
                if merged_ops != existing_ops:
                    patched_any = True
                new_line = f"{domain};{opset_str};{','.join(sorted(merged_ops))}\n"
                out_lines.append(new_line)
                continue
        out_lines.append(line)

    if not seen_ai_onnx_opset:
        print(
            "⚠️ 配置文件里没有找到任何 'ai.onnx;<opset>;...' 格式的行，"
            "没法确定要往哪个 opset 下面补充算子，未做任何修改，需要人工检查。",
            file=sys.stderr,
        )
        sys.exit(1)

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out_lines)

    print(f"{'✅ 已补充常见激活函数算子到' if patched_any else 'ℹ️ 常见激活函数算子本来就都在，未作改动：'} {path}")
    print("--- 修改后的完整内容 ---")
    print("".join(out_lines))


if __name__ == "__main__":
    main()
