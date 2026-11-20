#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""PreToolUse 命令护栏：检查钩子状态与常见绕过写法，不自动修改 Git 配置。

这不是安全边界。实际提交/推送规则由已安装的 Git 钩子执行；本入口在无法解析时
沿用既有 fail-open 契约。安装由维护者显式运行 tools/install-hooks.sh 或 .cmd。
"""

import json
import os
import re
import shlex
import subprocess
import sys

# 中文 Windows 下 Python 默认按 GBK 读写标准流，而 Claude Code 收发的都是 UTF-8：
# 不统一的话，命令里一有中文就解析失败、落进下面的放行分支。
for _s in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

HOOKS_DIR = "tools/githooks"
# commit 的 -n 是 --no-verify，可以并进组合短选项（-an）。
# push 的 -n 是 --dry-run，无害，所以只在 commit 上认 -n。
COMMIT_SHORT_NOVERIFY = re.compile(r"^-[A-Za-z]*n[A-Za-z]*$")


def split_segments(cmd):
    """保留引号中的分隔符，不把提交正文拆成 shell 命令。"""
    cmd = re.sub(r"\\\n", " ", cmd)          # 先接上反斜杠续行，否则切段会切断它
    lexer = shlex.shlex(cmd, posix=True, punctuation_chars=';&|\n')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    lexer.commenters = ''
    segment = []
    try:
        for token in lexer:
            if token and all(character in ';&|\n' for character in token):
                if segment:
                    yield segment
                    segment = []
            else:
                segment.append(token)
    except ValueError:
        return
    if segment:
        yield segment


def offending(cmd):
    """返回被拦下的理由（字符串），没问题则返回 None。"""
    for toks in split_segments(cmd):
        try:
            i = next(k for k, t in enumerate(toks)
                     if t.replace('\\', '/').rsplit('/', 1)[-1].lower() in ('git', 'git.exe'))
        except StopIteration:
            continue
        rest, sub, hooks_off = toks[i + 1:], None, False
        j = 0
        while j < len(rest):                 # 跳过 git 自己的全局选项
            t = rest[j]
            if t == "-c" and j + 1 < len(rest):
                if rest[j + 1].split("=", 1)[0].strip().lower() == "core.hookspath":
                    hooks_off = True
                j += 2
                continue
            if t in ('-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'):
                j += 2
                continue
            if t.startswith("-"):
                if t.lower().startswith("-ccore.hookspath"):
                    hooks_off = True
                j += 1
                continue
            sub = t
            rest = rest[j + 1:]
            break
        if sub not in ("commit", "push"):
            continue
        if hooks_off:
            return "-c core.hooksPath=…（把钩子目录换掉）"
        j = 0
        while j < len(rest):
            t = rest[j]
            if t == '--':
                break
            if sub == 'commit' and t in ('-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author', '--date', '--trailer'):
                j += 2
                continue
            if t == "--no-verify":
                return "--no-verify"
            if sub == "commit" and COMMIT_SHORT_NOVERIFY.match(t):
                return t + "（commit 的 -n 就是 --no-verify）"
            j += 1
    return None


def git(*args, **kw):
    return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=10, **kw)


def ensure_hooks_path(cwd):
    """只读核对 core.hooksPath，返回提示或 None。

    cwd 用钩子输入里的那个，不是本进程的——命令可能在别的仓库/子目录里跑，
    按本进程的 cwd 判会认错仓库。
    """
    top = git("rev-parse", "--show-toplevel", cwd=cwd)
    if top.returncode != 0:
        return None                                   # 不在 git 仓库里
    root = top.stdout.strip()
    if not os.path.isdir(os.path.join(root, HOOKS_DIR)):
        return None                                   # 不是本仓库

    cur = git("config", "--get", "core.hooksPath", cwd=root).stdout.strip()
    if cur == HOOKS_DIR:
        return None                                   # 已生效，安静通过
    if cur:
        # 别人自己配了别的钩子目录——不覆盖，只提醒。强制不该踩掉别人的设置。
        return ("提醒：core.hooksPath 当前是 %r，不是本仓库的 %s。"
                "本仓库的提交/分支检查不会生效；"
                "确认无误可跑 bash tools/install-hooks.sh。" % (cur, HOOKS_DIR))

    return ("尚未配置项目钩子；本工具只检查，不自动修改 Git 配置或覆盖默认钩子。"
            "需要安装时请运行 bash tools/install-hooks.sh。")


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except Exception:
        return 0
    cmd = ((data.get("tool_input") or {}).get("command") or "")
    if "git" not in cmd:
        return 0
    cwd = data.get("cwd") or None
    if cwd and not os.path.isdir(cwd):
        cwd = None

    try:
        note = ensure_hooks_path(cwd)
    except Exception:
        note = None                                   # fail-open

    try:
        why = offending(cmd)
    except Exception:
        why = None                                    # fail-open
    if why:
        sys.stderr.write(
            "\n✘ 不要绕过 git 钩子（检出：%s）。\n\n"
            "  那两个钩子（tools/githooks/）执行的是 CLAUDE.md「提交约定」与\n"
            "  AGENTS.md §0/§1 的硬规则，绕过它们等于绕过规则本身，而且不留痕迹。\n\n"
            "  确实需要跳过时用文档写明的逃生口——它们会在输出里留下记录：\n"
            "    提交信息里**顶格独占一行**写 [skip-hooks]   跳过提交信息检查\n"
            "    SKIP_BRANCH_HOOK=1 git push ...             跳过分支纪律检查\n\n"
            % why)
        return 2                                      # exit 2 = 拒绝，理由回喂给模型

    if note:
        sys.stderr.write("agent-guard: %s\n" % note)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
