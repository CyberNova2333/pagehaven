# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""显式安装项目钩子；已有自定义或默认钩子时拒绝覆盖。"""
from pathlib import Path
import subprocess
import sys


def git(*args):
    result = subprocess.run(['git', *args], capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=15)
    return result.stdout.strip() if result.returncode == 0 else ''


def main():
    root = git('rev-parse', '--show-toplevel')
    if not root:
        raise ValueError('当前目录不是 Git 仓库')
    configured = git('config', '--get', 'core.hooksPath')
    expected = Path(root) / 'tools/githooks'
    if configured:
        actual = Path(configured).expanduser()
        actual = actual if actual.is_absolute() else Path(root) / actual
        if actual.resolve() != expected.resolve():
            raise ValueError('已有自定义 core.hooksPath；保留现有设置，请先人工合并钩子')
    else:
        default = Path(git('rev-parse', '--git-path', 'hooks'))
        if default.exists() and any(item.is_file() and not item.name.endswith('.sample') for item in default.iterdir()):
            raise ValueError('默认钩子目录已有钩子；保留现有设置，请先人工合并钩子')
    for name in ('pre-commit', 'commit-msg', 'pre-push'):
        path = expected / name
        if not path.is_file():
            raise ValueError('项目钩子缺失：' + name)
        path.chmod(path.stat().st_mode | 0o111)
    if not configured:
        subprocess.run(['git', 'config', '--local', 'core.hooksPath', 'tools/githooks'], check=True)
    print('已接入 tools/githooks：内容安全、提交信息、分支与红灯检查；原有配置未被覆盖')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
