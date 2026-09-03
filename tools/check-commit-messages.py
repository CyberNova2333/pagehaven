#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CI 侧的提交信息检查：查一个提交区间，判据与 git 钩子共用（tools/githooks/_msgrules.py）。

为什么本地有两道钩子了还要这一道：commit-msg 只在装了钩子的克隆里生效，pre-push
有 SKIP_MSG_HOOK=1 这个口子。CI 跑在服务端，没有本地配置可绕，是最后一道。
于是 SKIP_MSG_HOOK=1 的真实语义是「先让我推上去，CI 那边我认」。
真要留一条不合规的信息在历史里，正规做法是顶格独占一行写 [skip-hooks]——记录在案的豁免。

用法：python3 tools/check-commit-messages.py <base>..<head>
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "githooks"))
import _msgrules  # noqa: E402


def git(*args):
    p = subprocess.run(["git", *args], capture_output=True, text=True)
    return p.stdout if p.returncode == 0 else ""


def main(argv):
    rng = argv[1] if len(argv) > 1 else "origin/main..HEAD"
    shas = [s for s in git("rev-list", "--no-merges", rng).split() if s]
    if not shas:
        print("✔ 区间 %s 内没有需要检查的提交" % rng)
        return 0
    bad = 0
    for sha in shas:
        msg = git("log", "-1", "--format=%B", sha)
        probs = _msgrules.problems(msg, drop_comments=False)
        subject = msg.split("\n")[0][:72]
        if probs:
            bad += 1
            print("\n✘ %s  %s" % (sha[:9], subject))
            for b in probs:
                print("  · " + b)
        else:
            print("✔ %s  %s" % (sha[:9], subject))
    if bad:
        print("\n共 %d / %d 个提交的信息不合规（规则见 AGENTS.md §1）。" % (bad, len(shas)))
        return 1
    print("\n✔ %d 个提交的信息全部合规" % len(shas))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
