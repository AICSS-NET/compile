#!/usr/bin/env python3
"""
修复 onnxruntime 源码里 cmake/external/eigen.cmake 下载 eigen3 依赖的方式。

背景：onnxruntime 原本用 CMake FetchContent 的 URL + URL_HASH 方式下载 eigen3
（从 GitLab 的"按 commit 打包 zip"接口下载，再校验 SHA1 哈希）。但 GitLab 这个
接口生成的 zip 不是字节稳定的，同一个 commit 每次打包出来的内容可能有细微差异
（比如内部时间戳），导致下载回来的文件哈希经常跟 onnxruntime 写死的预期值对不上，
构建直接失败。这是 onnxruntime 项目自己反复被报过的老问题（GitHub issue #18286、
#26707 等，跨越好几年），官方也没有根治。

解法：把"下载 zip + 校验哈希"换成"用 git 按 commit 拉取"——git clone 是靠 git
自己的对象哈希做完整性校验的，不会有"同一个 commit 打包出来的 zip 内容不稳定"
这个问题。CMake 的 FetchContent 本身就同时支持 URL+URL_HASH 和
GIT_REPOSITORY+GIT_TAG 这两种互斥写法，这是标准、文档化的用法，不是黑科技。

用法: python3 patch_eigen_cmake.py <eigen.cmake的路径>
"""

import re
import sys

EIGEN_COMMIT = "1d8b82b0740839c0de7f1242a3585e3390ff5f33"

OLD_PATTERN = re.compile(
    r"onnxruntime_fetchcontent_declare\(\s*"
    r"Eigen3\s*"
    r"URL\s+\$\{DEP_URL_eigen\}\s*"
    r"URL_HASH\s+SHA1=\$\{DEP_SHA1_eigen\}\s*"
    r"EXCLUDE_FROM_ALL\s*"
    r"\)",
    re.MULTILINE,
)

NEW_BLOCK = (
    "onnxruntime_fetchcontent_declare(\n"
    "    Eigen3\n"
    f"    GIT_REPOSITORY https://gitlab.com/libeigen/eigen.git\n"
    f"    GIT_TAG {EIGEN_COMMIT}\n"
    "    EXCLUDE_FROM_ALL\n"
    ")"
)


def main():
    if len(sys.argv) != 2:
        print("用法: python3 patch_eigen_cmake.py <eigen.cmake的路径>", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        content = f.read()

    new_content, count = OLD_PATTERN.subn(NEW_BLOCK, content)

    if count == 0:
        print(
            "❌ 没有匹配到预期的 onnxruntime_fetchcontent_declare(Eigen3 ...) 代码块，"
            "eigen.cmake 的内容可能跟这份脚本预期的不一样（比如 onnxruntime 版本升级后"
            "改了写法），需要人工检查，不能直接往下走。",
            file=sys.stderr,
        )
        print("--- 原文件内容 ---", file=sys.stderr)
        print(content, file=sys.stderr)
        sys.exit(1)

    if count > 1:
        print(f"⚠️ 匹配到 {count} 处，预期只有 1 处，请人工确认是否符合预期。", file=sys.stderr)

    with open(path, "w", encoding="utf-8") as f:
        f.write(new_content)

    print(f"✅ 已修复 {path}，替换了 {count} 处：")
    print(new_content)


if __name__ == "__main__":
    main()
