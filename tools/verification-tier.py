#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分层验证提示：按本次推送改动的路径，说明进入 main 的验证级别（CONTRIBUTING.md §二.3）。

检查流水线把输出写进构建日志。CI 能替代的只有前两级；后两级（真部署 / 真实数据查一次）
必须有人真跑过才算完，所以这里的作用是**把这件事说出来**，不是自动完成它。

用法：python3 tools/verification-tier.py <before-sha> <after-sha>
"""
import fnmatch
import subprocess
import sys

TIERS = (
    ("packages/platform/**", 3), ("scripts/deploy*", 3), ("scripts/publish*", 3), (".github/workflows/**", 3),
    ("packages/core/**", 2), ("packages/site/**", 2), ("packages/search/**", 2), ("scripts/**", 2),
    ("data/**", 1), ("docs/**", 1), ("*.md", 1), ("site.config.yaml", 1),
)
LEVELS = {
    0: "无需额外验证（只动了守卫/工具/配置文件）",
    1: "级别 1：npm run check（文档、data/、site.config.yaml）",
    2: "级别 2：+ npm test + npm run build 全量（packages/core、site、search、scripts）",
    3: "级别 3：+ 以 target=<平台> 向 preview **真实部署一次**——CI 替代不了，必须有人真跑过"
       "（packages/platform、scripts/deploy-*、workflow）",
}
SCHEMA_HINT = ("级别 4：动了数据 schema / DB 结构——还要**重建 DB 并在检索页上用真实数据查一次**")


def changed(before, after):
    if not before or set(before) == {"0"}:
        return []
    p = subprocess.run(["git", "diff", "--name-only", "%s..%s" % (before, after)],
                       capture_output=True, text=True)
    return [l for l in p.stdout.split("\n") if l.strip()] if p.returncode == 0 else []


def tier_of(path):
    best = 0
    for pat, t in TIERS:
        if fnmatch.fnmatch(path, pat) or fnmatch.fnmatch(path, pat.replace("/**", "/*")) \
                or (pat.endswith("/**") and path.startswith(pat[:-2])):
            best = max(best, t)
    return best


def main(argv):
    before = argv[1] if len(argv) > 1 else ""
    after = argv[2] if len(argv) > 2 else "HEAD"
    files = changed(before, after)
    print("## 分层验证提示\n")
    if not files:
        print("拿不到本次推送的 diff（新建分支或手动触发），略过。")
        return 0
    level = max((tier_of(f) for f in files), default=0)
    print("**%s**\n" % LEVELS[level])
    schema_touched = [f for f in files if f.startswith("packages/core/src/schema") or "build-db" in f]
    if schema_touched:
        print("**%s**\n" % SCHEMA_HINT)
    print("<details><summary>改动的 %d 个文件</summary>\n" % len(files))
    for f in files:
        print("- `%s`（级别 %d）" % (f, tier_of(f)))
    print("\n</details>")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
