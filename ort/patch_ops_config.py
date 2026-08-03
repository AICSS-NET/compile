#!/usr/bin/env python3
"""
在 convert_onnx_models_to_ort.py 自动生成的算子清单基础上，补充一批常见的 CNN
激活函数算子——不管自动扫描（静态分析优化后的图）有没有漏掉它们，都强制确保
这些算子在清单里。

背景：这批算子（Relu/HardSigmoid/Sigmoid/Clip/HardSwish/LeakyRelu/PRelu）几乎
出现在所有卷积神经网络里，PP-OCR 的骨干网络（MobileNet 系列常用 HardSigmoid/
HardSwish 做 Squeeze-and-Excitation 注意力模块）大概率会用到其中好几个。实测
遇到过自动生成的清单缺 Relu/HardSigmoid 导致 "Could not find an
implementation" 的报错，具体是自动扫描哪个环节漏的还没有百分百定位到（本地用
"部分算子会被图优化融合、部分不会"的混合场景测试过，机制本身工作正常，没能
复现出这个具体的缺失——可能是真实模型某个更复杂的结构触发的），所以先加这道
保险，不管漏没漏、强制把这批常见算子加进去，直接解决当前观察到的报错。

用法：python3 patch_ops_config.py <required_operators.config的路径>
"""

import re
import sys

# 常见的 CNN 激活函数算子，强制确保包含在清单里。
SAFETY_NET_OPS = {
    "Relu", "HardSigmoid", "Sigmoid", "Clip", "HardSwish", "LeakyRelu", "PRelu",
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
