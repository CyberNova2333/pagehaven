import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePnpmCommand } from '../lib/pnpm-runner.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const literals = ['path with spaces & literal', 'a|b', '$HOME', '$(echo ignored)', '%PATH%', '"quoted"', '--config'];

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pagehaven-pnpm-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(command, options = {}) {
  return spawnSync(command.command, command.args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, ...options });
}

test('pnpm 运行器：JavaScript 入口用 Node，参数中的空格和 shell 字符保持原样', async (t) => {
  const directory = await temporary(t);
  const parent = join(directory, 'path with spaces & symbols');
  await mkdir(parent);
  const entry = join(parent, 'pnpm.cjs');
  await writeFile(entry, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 19;\n');
  const command = resolvePnpmCommand(literals, { env: { npm_execpath: entry } });
  assert.equal(command.command, process.execPath);
  const result = run(command);
  assert.ifError(result.error);
  assert.equal(result.status, 19, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), literals);
});

test('pnpm 运行器：原生可执行文件直接启动，不把二进制交给 Node', async (t) => {
  const directory = await temporary(t);
  const entry = join(directory, process.platform === 'win32' ? 'pnpm-native.exe' : 'pnpm-native');
  await copyFile(process.execPath, entry);
  const command = resolvePnpmCommand(['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...literals], { env: { npm_execpath: entry } });
  assert.equal(command.command, entry);
  const result = run(command);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), literals);
});

test('pnpm 运行器：拒绝错误包管理器、shell shim、相对或缺失入口，不静默换程序', async (t) => {
  const directory = await temporary(t);
  for (const name of ['npm-cli.js', 'npm', 'pnpm.cmd', 'pnpm.ps1', 'arbitrary.js']) {
    const entry = join(directory, name);
    await writeFile(entry, 'throw new Error("must not run");\n');
    assert.throws(() => resolvePnpmCommand([], { env: { npm_execpath: entry, PATH: process.env.PATH } }), /pnpm run deploy/);
  }
  for (const entry of ['pnpm.cjs', join(directory, 'missing/pnpm.exe')]) {
    assert.throws(() => resolvePnpmCommand([], { env: { npm_execpath: entry } }), /pnpm run deploy/);
  }
  assert.throws(() => resolvePnpmCommand([], { env: { PATH: '' } }), /找不到.*pnpm/);
});

test('pnpm 运行器：PATH 支持 Corepack 与 pnpm 的 JS 安装布局，不执行 Windows shim', async (t) => {
  const directory = await temporary(t);
  const empty = join(directory, 'shim only');
  const install = join(directory, 'node install');
  await mkdir(empty);
  await writeFile(join(empty, 'pnpm.cmd'), '@echo must not run\r\n');
  for (const relative of ['node_modules/corepack/dist/pnpm.js', 'node_modules/pnpm/bin/pnpm.cjs']) {
    const entry = join(install, relative);
    await mkdir(join(entry, '..'), { recursive: true });
    await writeFile(entry, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const command = resolvePnpmCommand(literals, { env: { Path: `${empty};${install}` }, platform: 'win32' });
    assert.equal(command.command, process.execPath);
    const result = run(command);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), literals);
    await rm(entry);
  }
  assert.throws(() => resolvePnpmCommand([], { env: { Path: empty }, platform: 'win32' }), /找不到/);
});

test('pnpm 运行器：POSIX PATH 的符号链接解析到真实 JavaScript 入口', { skip: process.platform === 'win32' && 'POSIX 符号链接场景由 Linux 验证' }, async (t) => {
  const directory = await temporary(t);
  const bin = join(directory, 'bin');
  const entry = join(directory, 'pnpm.cjs');
  await mkdir(bin);
  await writeFile(entry, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  await symlink(entry, join(bin, 'pnpm'));
  const command = resolvePnpmCommand(literals, { env: { PATH: bin } });
  assert.equal(command.command, process.execPath);
  const result = run(command);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), literals);
});

test('pnpm 运行器：实际包管理器执行本地 tarball 的显式 bin，保持字面参数和退出码', { timeout: 90_000 }, async (t) => {
  const directory = await temporary(t);
  const fixture = join(directory, 'fixture');
  await mkdir(fixture);
  const { packageManager } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: 'pagehaven-runner-fixture', version: '1.0.0', packageManager,
    bin: { 'fixture-cli': 'cli.cjs' }, files: ['cli.cjs'],
  }));
  await writeFile(join(fixture, 'cli.cjs'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;\n');
  // 本地包无依赖，只验证包管理器启动及参数语法；不访问平台，不调用部署 CLI。
  const env = { ...process.env, COREPACK_ENABLE_NETWORK: '0' };
  const version = run(resolvePnpmCommand(['--version']), { cwd: ROOT, env });
  assert.ifError(version.error);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  const packed = run(resolvePnpmCommand(['pack', '--pack-destination', directory]), { cwd: fixture, env });
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const tarballs = (await readdir(directory)).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1);
  const result = run(resolvePnpmCommand([`--package=${join(directory, tarballs[0])}`, 'dlx', 'fixture-cli', ...literals]), { cwd: fixture, env });
  assert.ifError(result.error);
  assert.equal(result.status, 23, `${result.stdout}\n${result.stderr}`);
  const output = result.stdout.trim().split(/\r?\n/).find((line) => line.startsWith('['));
  assert.deepEqual(JSON.parse(output), literals);
});
