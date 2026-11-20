import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { withGithubSigning, GITHUB_AUTHOR } from '../ci/git-signing.mjs';
import { writeReleaseChanges } from '../ci/release-writeback.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000, ...extra });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pagehaven-writeback-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = join(dir, 'client');
  const remote = join(dir, 'remote.git');
  await mkdir(client);
  run('git', ['init', '--bare', remote], dir);
  run('git', ['init', '-b', 'main'], client);
  await cp(join(ROOT, 'tools'), join(client, 'tools'), { recursive: true });
  await mkdir(join(client, 'data/text/sample/one'), { recursive: true });
  await writeFile(join(client, 'data/text/sample/one/one.json'), '{}\n');
  await writeFile(join(client, 'STATUS.md'), 'old\n');
  run('git', ['add', '.'], client);
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], client);
  run('git', ['remote', 'add', 'origin', remote], client);
  run('git', ['push', 'origin', 'main'], client);
  const sha = run('git', ['rev-parse', 'HEAD'], client);
  const keyFile = join(dir, 'key');
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', GITHUB_AUTHOR.email, '-f', keyFile], dir);
  const key = await readFile(keyFile, 'utf8');
  return { dir, client, remote, sha, key, env: { ...process.env, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
    DEPLOY_ENV: 'production', DEPLOY_TARGET: 'workers', RELEASE_SIGNING_KEY: key, RELEASE_ACTIVATED: 'true' } };
}

test('GitHub 签名只用临时密钥，验证实际签名并在成功或失败后清理', async (t) => {
  const f = await fixture(t);
  let file;
  await withGithubSigning(f.key, async ({ gitArgs, env }) => {
    file = gitArgs.find((value) => value.startsWith('user.signingkey=')).split('=')[1];
    assert.ok(existsSync(file));
    assert.equal(env.RELEASE_SIGNING_KEY, undefined);
    run('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'fixture signed'], f.client, { env });
    run('git', ['verify-commit', 'HEAD'], f.client, { env });
    assert.equal(run('git', ['log', '-1', '--format=%ae'], f.client), GITHUB_AUTHOR.email);
  });
  assert.equal(existsSync(file), false);
  await assert.rejects(withGithubSigning(f.key, async ({ gitArgs }) => {
    file = gitArgs.find((value) => value.startsWith('user.signingkey=')).split('=')[1];
    throw new Error('fixture failure');
  }), /fixture failure/);
  assert.equal(existsSync(file), false);
});

test('失败写回只提交台词，成功写回允许状态，均以签名普通推送完成', async (t) => {
  for (const mode of ['data', 'status']) {
    const f = await fixture(t);
    await writeFile(join(f.client, 'STATUS.md'), 'new\n');
    await writeFile(join(f.client, 'data/text/sample/one/one.json'), '{"new":true}\n');
    const result = await writeReleaseChanges(mode, { cwd: f.client, env: f.env });
    assert.equal(result.committed, true);
    const paths = run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', result.commit], f.client).split('\n');
    assert.deepEqual(paths, mode === 'data' ? ['data/text/sample/one/one.json'] : ['STATUS.md', 'data/text/sample/one/one.json']);
    assert.equal(run('git', ['ls-remote', 'origin', 'refs/heads/main'], f.client).split(/\s/)[0], result.commit);
    assert.match(run('git', ['cat-file', '-p', result.commit], f.client), /gpgsig -----BEGIN SSH SIGNATURE-----/);
  }
});

test('main 变化、预览与混入暂存内容时拒绝写回', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.client, 'data/text/sample/one/one.json'), '{"new":true}\n');
  await assert.rejects(writeReleaseChanges('data', { cwd: f.client, env: { ...f.env, DEPLOY_ENV: 'preview' } }), /生产发布/);
  await writeFile(join(f.client, 'unrelated.txt'), 'other');
  run('git', ['add', 'unrelated.txt'], f.client);
  await assert.rejects(writeReleaseChanges('data', { cwd: f.client, env: f.env }), /暂存区/);
  run('git', ['reset', '--', 'unrelated.txt'], f.client);
  const other = run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit-tree', `${f.sha}^{tree}`, '-p', f.sha, '-m', 'concurrent'], f.client);
  run('git', ['push', 'origin', `${other}:main`], f.client);
  await assert.rejects(writeReleaseChanges('data', { cwd: f.client, env: f.env }), /main 已变化/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], f.client), f.sha);
});
