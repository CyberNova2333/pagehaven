import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { ROOT } from '../lib/paths.mjs';

const pipeline = yaml.load(await readFile(join(ROOT, '.cnb.yml'), 'utf8'));
const stage = pipeline.main.web_trigger_archive[0].stages.find((entry) => entry.script).script;
const env = { ...process.env, LC_ALL: 'C', GIT_AUTHOR_NAME: 'Archive Fixture', GIT_AUTHOR_EMAIL: 'archive@example.invalid',
  GIT_COMMITTER_NAME: 'Archive Fixture', GIT_COMMITTER_EMAIL: 'archive@example.invalid' };
function git(args, { cwd, input } = {}) {
  const result = spawnSync('git', args, { cwd, input, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const shell = process.platform === 'win32'
  ? resolve(git(['--exec-path']), '../../..', 'usr/bin/bash.exe') : 'bash';
const shellEnv = { ...env };
if (process.platform === 'win32') {
  const pathKey = Object.keys(shellEnv).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  shellEnv[pathKey] = dirname(shell) + delimiter + (shellEnv[pathKey] || '');
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pagehaven-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  const writer = join(dir, 'writer');
  const client = join(dir, 'client');
  git(['init', '--bare', remote]);
  git(['init', writer]);
  const write = (args, input) => git(args, { cwd: writer, input });
  const tree = write(['hash-object', '-t', 'tree', '--stdin', '-w'], '');
  const main = write(['commit-tree', tree, '-m', 'fixture main']);
  const first = write(['commit-tree', tree, '-p', main, '-m', 'fixture first']);
  const next = write(['commit-tree', tree, '-p', first, '-m', 'fixture next']);
  write(['push', remote, `${main}:refs/heads/main`, `${first}:refs/heads/fixture`]);
  // 独立工作区模拟只检出 main 的 CI；禁用本地 clone 优化，避免整份对象库被复制进来。
  git(['clone', '--no-local', '--depth', '1', '--single-branch', '--branch', 'main', remote, client]);
  const run = (args, input) => git(args, { cwd: client, input });
  for (const sha of [first, next]) {
    assert.notEqual(spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: client, env }).status, 0,
      '归档客户端事先不应拥有待归档或竞争提交');
  }
  // 只替换真实远端的来源；分支保护、标签核对及删除命令执行流水线原文。
  const localStage = stage.replace(/^repo_url=.*$/m, 'repo_url="$FIXTURE_REMOTE"');
  assert.notEqual(localStage, stage);
  const execute = (script = localStage, branch = 'fixture') => spawnSync(shell, ['-c', script], {
    cwd: client, encoding: 'utf8', timeout: 15_000,
    env: { ...shellEnv, branch, FIXTURE_REMOTE: remote, FIXTURE_WRITER: writer, FIXTURE_NEXT_SHA: next },
  });
  return { remote, client, run, write, main, first, next, localStage, execute };
}

test('归档执行真实阶段：main 浅克隆获取缺失顶点后归档，仅删除已核对分支', async (t) => {
  const f = await fixture(t);
  const result = f.execute();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.run(['ls-remote', '--heads', f.remote, 'refs/heads/fixture']), '');
  assert.equal(f.run(['ls-remote', '--tags', f.remote, 'refs/tags/archive/fixture']).split(/\s/)[0], f.first);
  assert.equal(f.run(['rev-parse', 'FETCH_HEAD']), f.first, '实际获取的是已核对顶点');
  assert.equal(f.run(['rev-parse', 'HEAD']), f.main, '归档不切换或修改客户端 main');
  assert.equal(f.run(['ls-remote', '--heads', f.remote, 'refs/heads/main']).split(/\s/)[0], f.main);
});

test('归档执行真实阶段：观测后、获取前分支变化时拒绝创建标签和删除', async (t) => {
  const f = await fixture(t);
  const raced = f.localStage.replace(/^(git fetch --no-tags --depth=1 .*?)$/m,
    'git -C "$FIXTURE_WRITER" push "$FIXTURE_REMOTE" "$FIXTURE_NEXT_SHA:refs/heads/fixture"\n$1');
  assert.notEqual(raced, f.localStage);
  const result = f.execute(raced);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /获取期间分支已变化/);
  assert.equal(f.run(['ls-remote', '--heads', f.remote, 'refs/heads/fixture']).split(/\s/)[0], f.next);
  assert.equal(f.run(['ls-remote', '--tags', f.remote, 'refs/tags/archive/fixture']), '');
});

test('归档执行真实阶段：获取后竞争更新仍由 lease 保留新分支，标签只保存已核对顶点', async (t) => {
  const f = await fixture(t);
  const raced = f.localStage.replace(/^(git push "\$repo_url" "\$sha:refs\/tags\/\$tag")$/m,
    'git -C "$FIXTURE_WRITER" push "$FIXTURE_REMOTE" "$FIXTURE_NEXT_SHA:refs/heads/fixture"\n$1');
  assert.notEqual(raced, f.localStage);
  const result = f.execute(raced);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /stale info/);
  assert.equal(f.run(['ls-remote', '--heads', f.remote, 'refs/heads/fixture']).split(/\s/)[0], f.next);
  assert.equal(f.run(['ls-remote', '--tags', f.remote, 'refs/tags/archive/fixture']).split(/\s/)[0], f.first);
});

test('归档执行真实阶段：标签核对后竞争更新导致删除失败，新提交仍有分支引用', async (t) => {
  const f = await fixture(t);
  const raced = f.localStage.replace(/^(git push --force-with-lease=.*)$/m,
    'git -C "$FIXTURE_WRITER" push "$FIXTURE_REMOTE" "$FIXTURE_NEXT_SHA:refs/heads/fixture"\n$1');
  assert.notEqual(raced, f.localStage);
  const result = f.execute(raced);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /stale info/);
  assert.equal(f.run(['ls-remote', '--heads', f.remote, 'refs/heads/fixture']).split(/\s/)[0], f.next);
  assert.equal(f.run(['ls-remote', '--tags', f.remote, 'refs/tags/archive/fixture']).split(/\s/)[0], f.first);
});

test('归档拒绝已存在标签、main 与非精确分支名', async (t) => {
  const f = await fixture(t);
  f.write(['push', f.remote, `${f.next}:refs/tags/archive/fixture`]);
  assert.notEqual(f.execute().status, 0);
  for (const branch of ['main', 'archive/fixture', 'fixture*', 'fixture..other', 'fixture\nother', '../fixture', '']) {
    const result = f.execute(f.localStage, branch);
    assert.notEqual(result.status, 0, branch);
  }
  assert.equal(f.run(['ls-remote', '--heads', f.remote, 'refs/heads/fixture']).split(/\s/)[0], f.first);
  assert.equal(f.run(['ls-remote', '--tags', f.remote, 'refs/tags/archive/fixture']).split(/\s/)[0], f.next,
    '已存在且顶点不同的 archive 标签仍保持原样');
});
