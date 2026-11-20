// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

async function cleanupPagesDirectory(directory) {
  const absolute = resolve(directory);
  if (dirname(absolute) !== resolve(tmpdir()) || !absolute.startsWith(join(resolve(tmpdir()), 'pagehaven-pages-'))) {
    throw new Error('Pages 临时目录边界校验失败，拒绝清理');
  }
  await rm(absolute, { recursive: true, force: true });
}

// 先确认远端分支是否存在；读取失败不是首次发布，竞争写入也不能覆盖。
export async function pushGithubPages({ distDir, repo, token, version, gitArgs, env, spawnImpl = spawnSync }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || repo.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('GitHub Pages 仓库必须是 owner/repo');
  }
  if (!token || typeof token !== 'string') throw new Error('缺少 GitHub Pages 发布凭据');
  const remote = `https://github.com/${repo}.git`;
  const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
  const childEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  const count = Number(childEnv.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Git 临时配置计数无效');
  childEnv.GIT_CONFIG_COUNT = String(count + 1);
  childEnv[`GIT_CONFIG_KEY_${count}`] = 'http.https://github.com/.extraheader';
  childEnv[`GIT_CONFIG_VALUE_${count}`] = `AUTHORIZATION: basic ${auth}`;
  delete childEnv.GITHUB_PAGES_TOKEN;
  const scrub = (value) => String(value).split(token).join('***').split(auth).join('***');
  const directory = await mkdtemp(join(tmpdir(), 'pagehaven-pages-'));
  const git = (args) => {
    const result = spawnImpl('git', [...gitArgs, '-c', 'credential.helper=', ...args], {
      cwd: directory, encoding: 'utf8', env: childEnv,
    });
    if (result.status !== 0) {
      throw new Error(scrub(`git ${args[0]} 失败（退出码 ${result.status ?? '起不来'}）：${result.stderr || result.stdout || ''}`));
    }
    return (result.stdout || '').trim();
  };
  try {
    const ref = 'refs/heads/gh-pages';
    const observed = git(['ls-remote', '--heads', remote, ref]);
    if (observed) {
      if (!new RegExp(`^[a-f0-9]{40}\\s+${ref}$`).test(observed)) throw new Error('GitHub Pages 远端分支响应无效');
      git(['clone', '--depth', '1', '--single-branch', '--branch', 'gh-pages', remote, '.']);
    } else {
      git(['init', '--quiet']);
      git(['checkout', '--quiet', '-b', 'gh-pages']);
      git(['remote', 'add', 'origin', remote]);
    }
    for (const name of await readdir(directory)) {
      if (name !== '.git') await rm(join(directory, name), { recursive: true, force: true });
    }
    for (const name of await readdir(distDir)) await cp(join(distDir, name), join(directory, name), { recursive: true });
    git(['add', '-A']);
    if (!git(['status', '--porcelain'])) return { pushed: false, commit: git(['rev-parse', 'HEAD']) };
    const message = version ? `chore(pages): 发布 ${version}` : 'chore(pages): 发布';
    git(['commit', '--quiet', '-m', message]);
    git(['push', 'origin', 'HEAD:refs/heads/gh-pages']);
    return { pushed: true, commit: git(['rev-parse', 'HEAD']) };
  } finally {
    await cleanupPagesDirectory(directory);
  }
}
