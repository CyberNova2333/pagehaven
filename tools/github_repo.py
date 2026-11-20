# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""GitHub 主仓库定位；只读远端和 Git 对象，不改配置或引用。"""
import re
import subprocess
from urllib.parse import urlsplit


def git(*args):
    result = subprocess.run(['git', *args], capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=30)
    return result.stdout.strip() if result.returncode == 0 else ''


def github_slug(url):
    if url.startswith('git@github.com:'):
        path = url[len('git@github.com:'):]
    else:
        parsed = urlsplit(url)
        if parsed.hostname != 'github.com' or parsed.scheme not in ('https', 'ssh'):
            return None
        if parsed.query or parsed.fragment:
            return None
        path = parsed.path.lstrip('/')
    path = path.rstrip('/')
    if path.endswith('.git'):
        path = path[:-4]
    return path if re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', path) else None


def github_remote(preferred=None):
    remotes = git('remote').splitlines()
    candidates = []
    for name in remotes:
        slug = github_slug(git('remote', 'get-url', name))
        if slug:
            candidates.append((name, slug))
    for name in (preferred, 'github', 'origin'):
        for candidate in candidates:
            if candidate[0] == name:
                return candidate
    if len(candidates) == 1:
        return candidates[0]
    raise ValueError('无法唯一确定 GitHub 主远端；请核对远端配置')


def equivalent_commit(sha, remote):
    """找到主线中的等价文件树和消息，兼容备用端的重签提交编号。"""
    tree = git('rev-parse', sha + '^{tree}')
    message = git('log', '-1', '--format=%B', sha)
    if not tree:
        return None
    for ref in ('refs/remotes/' + remote + '/main', 'refs/heads/main'):
        for candidate in git('rev-list', '--max-count=200', ref).splitlines():
            if git('rev-parse', candidate + '^{tree}') == tree and git('log', '-1', '--format=%B', candidate) == message:
                return candidate
    return None
