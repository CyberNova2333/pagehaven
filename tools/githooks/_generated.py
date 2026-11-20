# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""发布生成提交的窄例外；正文标记本身不能豁免路径、身份或签名。"""
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

IDENTITY = 'CyberNova <295488275+CyberNova2333@users.noreply.github.com>'
EMAIL = '295488275+CyberNova2333@users.noreply.github.com'
MARKER = 'Generated-by: Pagehaven release'
SUBJECTS = {
    'chore(status): 发布后更新状态与台词': True,
    'chore(data): 发布中断后保全台词': False,
}


def git(*args):
    result = subprocess.run(['git', *args], capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=30)
    if result.returncode:
        raise ValueError('生成提交检查无法读取 Git 对象或配置')
    return result.stdout


def requested(raw):
    return any(line == MARKER for line in raw.splitlines())


def validate_message(raw):
    lines = raw.strip().splitlines()
    if not lines or lines[0] not in SUBJECTS or lines.count(MARKER) != 1 or lines[-1] != MARKER:
        raise ValueError('生成提交必须使用固定标题和末尾 Generated-by 标记')
    if any(line.startswith('Co-authored-by:') or line == '[skip-hooks]' for line in lines):
        raise ValueError('生成提交不能伪造共著者或跳过钩子')
    if not any(line.startswith(('文档:', '文档：')) for line in lines):
        raise ValueError('生成提交必须保留文档说明')
    return SUBJECTS[lines[0]]


def validate_paths(records, allow_status):
    if not records:
        raise ValueError('生成提交没有允许写回的文件')
    fields = records.rstrip('\0').split('\0')
    if len(fields) % 2:
        raise ValueError('生成提交的文件清单无效')
    for status, path in zip(fields[::2], fields[1::2]):
        allowed = (allow_status and path == 'STATUS.md') or (
            path.startswith('data/text/') and path.endswith('.json')
            and all(part not in ('', '.', '..') for part in path.split('/')))
        if status not in ('A', 'M') or not allowed:
            raise ValueError('生成提交包含不允许的路径或删除/重命名操作：' + path)


def validate_index(raw):
    allow_status = validate_message(raw)
    for role in ('GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'):
        if git('var', role).rsplit(' ', 2)[0] != IDENTITY:
            raise ValueError('生成提交必须使用登记的 GitHub 作者与提交者')
    if git('config', '--get', 'gpg.format').strip() != 'ssh' or git('config', '--get', 'commit.gpgsign').strip() != 'true':
        raise ValueError('生成提交必须启用 SSH 签名')
    if not git('config', '--get', 'user.signingkey').strip():
        raise ValueError('生成提交缺少 SSH 签名密钥配置')
    validate_paths(git('diff', '--cached', '--name-status', '--no-renames', '-z'), allow_status)
    for line in git('ls-files', '--stage').splitlines():
        metadata, _, path = line.partition('\t')
        if (path == 'STATUS.md' or path.startswith('data/text/')) and metadata.split()[0] != '100644':
            raise ValueError('生成文件必须是普通非可执行文件：' + path)


def verify_signature(sha, email=EMAIL):
    header = git('cat-file', 'commit', sha).split('\n\n', 1)[0]
    if 'gpgsig -----BEGIN SSH SIGNATURE-----' not in header:
        raise ValueError('生成提交缺少 SSH 签名')
    # 已有本地信任配置优先；绝不读取私钥。
    try:
        git('verify-commit', sha)
        if git('log', '-1', '--format=%GS', sha).strip() == email:
            return
    except ValueError:
        pass
    if email != EMAIL:
        raise ValueError('备用签名必须由本地登记的独立签名公钥验证')
    gh = shutil.which('gh')
    if not gh:
        raise ValueError('无法验证生成提交签名：缺少本地信任配置和 GitHub CLI')
    result = subprocess.run([gh, 'api', 'users/CyberNova2333/ssh_signing_keys'], capture_output=True,
                            text=True, encoding='utf-8', errors='replace', timeout=30)
    if result.returncode:
        raise ValueError('无法读取登记的 GitHub 签名公钥')
    keys = json.loads(result.stdout)
    entries = [item.get('key', '') for item in keys if isinstance(item, dict)] if isinstance(keys, list) else []
    entries = [key for key in entries if re.fullmatch(r'(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+(?: [^\r\n]*)?', key)]
    if not entries:
        raise ValueError('GitHub 未登记可验证的 SSH 签名公钥')
    with tempfile.TemporaryDirectory(prefix='pagehaven-signers-') as directory:
        path = Path(directory) / 'allowed-signers'
        path.write_text(''.join(EMAIL + ' ' + key + '\n' for key in entries), encoding='utf-8')
        git('-c', 'gpg.ssh.allowedSignersFile=' + str(path), 'verify-commit', sha)


def validate_commit(sha, raw):
    allow_status = validate_message(raw)
    identity = git('show', '-s', '--format=%an <%ae>%n%cn <%ce>%n%P', sha).strip().splitlines()
    if len(identity) != 3 or identity[:2] != [IDENTITY, IDENTITY] or len(identity[2].split()) != 1:
        raise ValueError('生成提交必须是登记身份的单父提交')
    validate_paths(git('diff-tree', '--no-commit-id', '--name-status', '--no-renames', '-r', '-z', sha), allow_status)
    for line in git('ls-tree', '-r', sha, '--', 'STATUS.md', 'data/text').splitlines():
        if line.split()[0] != '100644':
            raise ValueError('生成文件必须是普通非可执行文件')
    verify_signature(sha)
