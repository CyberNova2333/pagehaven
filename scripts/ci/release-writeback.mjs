#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withGithubSigning } from './git-signing.mjs';

export function allowedReleasePath(path, mode) {
  return (mode === 'status' && path === 'STATUS.md') || /^data\/text\/[^/]+\/[^/]+\/[^/]+\.json$/.test(path);
}

export async function writeReleaseChanges(mode, { cwd = process.cwd(), env = process.env } = {}) {
  if (!['status', 'data'].includes(mode)) throw new Error('写回模式只能是 status 或 data');
  if (env.GITHUB_REF !== 'refs/heads/main' || env.DEPLOY_ENV !== 'production' || !env.DEPLOY_TARGET || env.DEPLOY_TARGET === 'none' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) {
    throw new Error('只有 main 的生产发布允许写回');
  }
  if (mode === 'status' && env.RELEASE_ACTIVATED !== 'true') throw new Error('未确认生产启用，不能写回状态');
  const execute = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, ...options });
    if (result.error || result.status !== 0) throw new Error(`${command} ${args.find((arg) => !arg.startsWith('-')) || ''} 执行失败，发布工件仍可取回`);
    return result.stdout.trim();
  };
  const git = (...args) => execute('git', args);
  if (git('rev-parse', 'HEAD') !== env.GITHUB_SHA) throw new Error('工作区提交与发布基线不一致');
  if (git('diff', '--cached', '--name-only')) throw new Error('写回前暂存区必须为空，拒绝混入先前暂存内容');
  const paths = mode === 'status' ? ['STATUS.md', 'data/text'] : ['data/text'];
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', ...paths);
  if (!changed) return { committed: false };
  const remoteHead = () => git('ls-remote', '--exit-code', 'origin', 'refs/heads/main').split(/\s/)[0];
  if (remoteHead() !== env.GITHUB_SHA) throw new Error('main 已变化，拒绝覆盖；请从发布工件取回改动');
  git('add', '--', ...paths);
  const staged = git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
  if (!staged.length) return { committed: false };
  if (staged.some((path) => !allowedReleasePath(path, mode))) throw new Error('写回包含不允许的路径');
  const modes = git('diff', '--cached', '--raw').split('\n').filter(Boolean);
  if (modes.some((line) => !/^:(?:000000|100644) 100644 [a-f0-9]+ [a-f0-9]+ [AM]\t/.test(line))) throw new Error('写回只允许新增或修改普通文本文件');
  const python = ['python3', 'python'].find((command) => spawnSync(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore' }).status === 0);
  if (!python) throw new Error('签名写回需要 Python 3.10+ 执行提交守卫');
  execute(python, ['tools/repo_maintenance_guard.py', 'pre-commit']);
  const title = mode === 'status' ? 'chore(status): 发布后更新状态与台词' : 'chore(data): 发布中断后保全台词';
  const message = `${title}\n\n文档: 发布工作流生成状态与导入台词，其他文档不变。\n\nGenerated-by: Pagehaven release\n`;
  return withGithubSigning(env.RELEASE_SIGNING_KEY, async ({ gitArgs, env: signingEnv }) => {
    execute('git', [...gitArgs, 'commit', '-F', '-'], { input: message, env: signingEnv });
    const commit = git('rev-parse', 'HEAD');
    execute(python, ['tools/check-commit-messages.py', `${env.GITHUB_SHA}..${commit}`], { env: signingEnv });
    if (remoteHead() !== env.GITHUB_SHA) throw new Error('main 在写回期间变化，保留工件供人工合并');
    execute('git', ['push', 'origin', 'HEAD:refs/heads/main'], { env: signingEnv });
    return { committed: true, commit };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeReleaseChanges(process.argv[2]).then((result) => {
    console.log(result.committed ? '发布改动已签名并写回' : '没有需要写回的发布改动');
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
