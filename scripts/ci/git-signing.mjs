// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const GITHUB_AUTHOR = { name: 'CyberNova', email: '295488275+CyberNova2333@users.noreply.github.com' };

// 密钥只属于本次 Git 操作；不读取本机私钥，也不修改仓库的持久配置或钩子。
export async function withGithubSigning(key, operation) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('缺少有效的 RELEASE_SIGNING_KEY');
  const directory = await mkdtemp(join(tmpdir(), 'pagehaven-signing-'));
  try {
    const signingFile = join(directory, 'signing-key');
    await writeFile(signingFile, key.trim() + '\n', { mode: 0o600 });
    const publicKey = spawnSync('ssh-keygen', ['-y', '-f', signingFile], { encoding: 'utf8', timeout: 10_000 });
    if (publicKey.error || publicKey.status !== 0 || !/^ssh-ed25519 /.test(publicKey.stdout)) throw new Error('RELEASE_SIGNING_KEY 必须是可用的 GitHub 专用 Ed25519 SSH 签名密钥');
    const signersFile = join(directory, 'allowed-signers');
    await writeFile(signersFile, `${GITHUB_AUTHOR.email} ${publicKey.stdout.trim()}\n`, { mode: 0o600 });
    const env = { ...process.env, GIT_AUTHOR_NAME: GITHUB_AUTHOR.name, GIT_AUTHOR_EMAIL: GITHUB_AUTHOR.email,
      GIT_COMMITTER_NAME: GITHUB_AUTHOR.name, GIT_COMMITTER_EMAIL: GITHUB_AUTHOR.email };
    for (const name of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(name)) delete env[name];
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'gpg.ssh.allowedSignersFile';
    env.GIT_CONFIG_VALUE_0 = signersFile;
    for (const name of ['RELEASE_SIGNING_KEY', 'PUBLISH_SECRETS_YML', 'DEPLOY_SECRETS_YML']) delete env[name];
    return await operation({ env, gitArgs: ['-c', `user.name=${GITHUB_AUTHOR.name}`, '-c', `user.email=${GITHUB_AUTHOR.email}`,
      '-c', 'gpg.format=ssh', '-c', `user.signingkey=${signingFile}`, '-c', 'commit.gpgsign=true', '-c', `gpg.ssh.allowedSignersFile=${signersFile}`] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
