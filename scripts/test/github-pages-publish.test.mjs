import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withGithubSigning, GITHUB_AUTHOR } from '../ci/git-signing.mjs';
import { pushGithubPages } from '../lib/github-pages-publish.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pagehaven-pages-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, 'remote.git');
  const writer = join(directory, 'writer');
  const distDir = join(directory, 'dist');
  await mkdir(distDir);
  await writeFile(join(distDir, 'index.html'), '<title>发布夹具</title>');
  const config = join(directory, 'gitconfig');
  await writeFile(config, `[url "${pathToFileURL(remote).href}"]\n  insteadOf = https://github.com/fixture/pages.git\n[protocol "file"]\n  allow = always\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const name of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(name)) delete env[name];
  const git = (args, cwd = directory) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--bare', remote]);
  git(['init', writer]);
  const emptyTree = git(['hash-object', '-t', 'tree', '--stdin', '-w'], writer);
  const commit = (message, parent) => git(['commit-tree', emptyTree, ...(parent ? ['-p', parent] : []), '-m', message], writer);
  const publish = (sha) => git(['push', remote, `${sha}:refs/heads/gh-pages`], writer);
  const head = () => git(['rev-parse', 'refs/heads/gh-pages'], remote);
  const keyFile = join(directory, 'signing');
  const keygen = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', GITHUB_AUTHOR.email, '-f', keyFile], { encoding: 'utf8' });
  assert.equal(keygen.status, 0, keygen.stderr);
  const key = await readFile(keyFile, 'utf8');
  const operation = (spawnImpl = spawnSync) => withGithubSigning(key, ({ gitArgs, env: signingEnv }) => pushGithubPages({
    distDir, repo: 'fixture/pages', token: 'fixture-token', version: 'fixture-release', gitArgs,
    env: { ...signingEnv, ...env, GIT_AUTHOR_NAME: GITHUB_AUTHOR.name, GIT_AUTHOR_EMAIL: GITHUB_AUTHOR.email,
      GIT_COMMITTER_NAME: GITHUB_AUTHOR.name, GIT_COMMITTER_EMAIL: GITHUB_AUTHOR.email }, spawnImpl,
  }));
  return { directory, remote, writer, git, commit, publish, head, operation, keyFile };
}

test('Pages 发布：首次建立分支、真实 SSH 签名、重复相同产物不新增提交', async (t) => {
  const f = await fixture(t);
  let temporary;
  const result = await f.operation((command, args, options) => {
    assert.ok(args.every((arg) => !arg.includes('fixture-token')), '凭据不能出现在命令参数');
    temporary = options.cwd;
    return spawnSync(command, args, options);
  });
  assert.equal(result.pushed, true);
  assert.equal(f.head(), result.commit);
  assert.equal(f.git(['show', `${result.commit}:index.html`], f.remote), '<title>发布夹具</title>');
  const raw = f.git(['cat-file', '-p', result.commit], f.remote);
  assert.match(raw, /gpgsig /);
  assert.ok(raw.includes(`author ${GITHUB_AUTHOR.name} <${GITHUB_AUTHOR.email}>`));
  const allowed = join(f.directory, 'allowed-signers');
  await writeFile(allowed, `${GITHUB_AUTHOR.email} ${await readFile(`${f.keyFile}.pub`, 'utf8')}`);
  f.git(['-c', `gpg.ssh.allowedSignersFile=${allowed}`, 'verify-commit', result.commit], f.remote);
  await assert.rejects(readFile(join(temporary, '.git/config')), { code: 'ENOENT' });
  assert.deepEqual(await f.operation(), { pushed: false, commit: result.commit });
});

test('Pages 发布：远端分支存在但 clone 失败时停止，不初始化或推送覆盖', async (t) => {
  const f = await fixture(t);
  const original = f.commit('initial');
  f.publish(original);
  const commands = [];
  await assert.rejects(f.operation((command, args, options) => {
    commands.push(args);
    if (args.includes('clone')) return { status: 1, stderr: 'fixture-token clone failed' };
    return spawnSync(command, args, options);
  }), (error) => /git clone 失败/.test(error.message) && !error.message.includes('fixture-token'));
  assert.equal(commands.some((args) => args.includes('init') || args.includes('push')), false);
  assert.equal(f.head(), original);
});

test('Pages 发布：创建发布提交后远端推进，普通推送拒绝覆盖竞争提交', async (t) => {
  const f = await fixture(t);
  const original = f.commit('initial');
  f.publish(original);
  const competing = f.commit('concurrent update', original);
  let advanced = false;
  await assert.rejects(f.operation((command, args, options) => {
    if (args.includes('push')) {
      assert.equal(args.includes('--force'), false);
      f.publish(competing);
      advanced = true;
    }
    return spawnSync(command, args, options);
  }), /git push 失败/);
  assert.equal(advanced, true);
  assert.equal(f.head(), competing);
});

test('Pages 发布：读取远端失败不能当作不存在分支', async (t) => {
  const f = await fixture(t);
  const commands = [];
  await assert.rejects(f.operation((command, args) => {
    commands.push(args);
    return { status: 128, stderr: 'remote unavailable' };
  }), /git ls-remote 失败/);
  assert.equal(commands.length, 1);
});
