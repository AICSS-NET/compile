#!/usr/bin/env python3
"""
给 pdf.js 的 gulpfile.mjs 打两处补丁，让 `gulp generic-legacy` 产出真正的
非 module（UMD/经典 <script>）主文件，而不是官方现在默认的 .mjs（ESM）。

背景见 .github/workflows/build-pdfjs-legacy.yml 顶部的说明注释。

用法：python3 patch-pdfjs-legacy.py <gulpfile.mjs 的路径>

设计原则：用正则只锚定"必定唯一、且与本次改动直接相关"的一小段文本，
不依赖整段代码的精确缩进/换行（缩进在不同版本之间很容易发生无意义的变化）。
只要上游还没有整体重构这几个函数，这里的锚点就应该继续有效；
一旦锚点找不到，脚本会直接非 0 退出并打印清楚的报错，而不是静默不生效。
"""
import re
import sys


def die(msg):
    print(f"[patch-pdfjs-legacy] 错误：{msg}", file=sys.stderr)
    sys.exit(1)


def patch_main_bundle_output(content):
    """
    补丁 1：createMainBundle() 里主文件的 webpack 输出，从
      filename: defines.MINIFIED ? "pdf.min.mjs" : "pdf.mjs",
      library: { type: "module", },
    改成
      filename: defines.MINIFIED ? "pdf.min.js" : "pdf.js",
      library: { type: "umd", name: "pdfjsLib", },

    用 "pdf.min.mjs" : "pdf.mjs" 这个字符串组合定位 filename 那一行，
    这个组合只在 createMainBundle 里出现（其它 bundle 用的是不同的文件名），
    再往后紧跟着找最近的 `library: {\\s*type: "module",\\s*}`，两处一起替换。
    """
    filename_pattern = re.compile(
        r'filename:\s*defines\.MINIFIED\s*\?\s*"pdf\.min\.mjs"\s*:\s*"pdf\.mjs",'
    )
    m = filename_pattern.search(content)
    if not m:
        die(
            "在 gulpfile.mjs 里找不到 createMainBundle 的 filename 那一行"
            '（期望类似 filename: defines.MINIFIED ? "pdf.min.mjs" : "pdf.mjs",）。'
            "说明上游改了这部分代码，需要更新这个补丁脚本的锚点。"
        )

    library_pattern = re.compile(
        r'library:\s*\{\s*type:\s*"module",?\s*\},'
    )
    lm = library_pattern.search(content, m.end())
    if not lm or lm.start() - m.end() > 200:
        die(
            "在 createMainBundle 的 filename 后面找不到紧跟着的 "
            'library: { type: "module" } 配置。说明上游改了这部分代码结构，'
            "需要更新这个补丁脚本的锚点。"
        )

    new_filename = 'filename: defines.MINIFIED ? "pdf.min.js" : "pdf.js",'
    new_library = 'library: {\n      type: "umd",\n      name: "pdfjsLib",\n    },'

    # 从后往前替换，避免前面替换后偏移量错位
    content = content[: lm.start()] + new_library + content[lm.end():]
    content = content[: m.start()] + new_filename + content[m.end():]
    return content


def patch_import_meta_parser(content):
    """
    补丁 2：createWebpackConfig() 里控制 webpack 是否处理/转换 import.meta 的开关，
    从写死的 `importMeta: false,` 改成 `importMeta: !isModule,`——
    只有生成非 module 产物（也就是我们刚改过的主文件）时才需要 webpack 帮忙把
    import.meta.url 转换成一个非 ESM 环境也能用的等价实现；其余仍然输出 .mjs 的
    产物（worker / sandbox / scripting / viewer 等）保持原来 false（不处理），
    不受影响。

    用 `importMeta: false,` 紧跟在 `parser: {` / `javascript: {` 结构里的
    这个特征来定位，这个精确写法在文件里只应该出现一次。
    """
    pattern = re.compile(
        r'(parser:\s*\{\s*javascript:\s*\{\s*)importMeta:\s*false,'
    )
    matches = list(pattern.finditer(content))
    if len(matches) != 1:
        die(
            "在 parser.javascript.importMeta 这段配置上找到了 "
            f"{len(matches)} 处匹配（期望正好 1 处）。"
            "说明上游改了 createWebpackConfig 的写法，需要更新这个补丁脚本的锚点。"
        )
    m = matches[0]
    content = content[: m.start()] + m.group(1) + "importMeta: !isModule," + content[m.end():]
    return content


def main():
    if len(sys.argv) != 2:
        die("用法: patch-pdfjs-legacy.py <gulpfile.mjs 的路径>")

    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        content = f.read()

    before = content
    content = patch_main_bundle_output(content)
    content = patch_import_meta_parser(content)

    if content == before:
        die("补丁没有产生任何实际改动，逻辑有问题，请检查脚本。")

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

    print("[patch-pdfjs-legacy] 两处补丁都已成功应用。")


if __name__ == "__main__":
    main()
