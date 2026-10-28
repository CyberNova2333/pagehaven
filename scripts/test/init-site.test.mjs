// 真执行初始化 CLI，配置与备份都写入独立临时目录，避免污染站点共享生成物。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSiteConfig } from '@gallery/platform';
import { planInit, writeInitConfig } from '../lib/init-site.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'init-site.mjs');
const TEMPLATE = await readFile(join(ROOT, 'site.config.yaml'), 'utf8');

async function workspace(t, text = TEMPLATE) {
  const dir = await mkdtemp(join(tmpdir(), 'pagehaven-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'site.config.yaml');
  await writeFile(config, text);
  return { dir, config, text, out: join(dir, 'out'), backupDir: join(dir, 'out', 'init') };
}

function run(ws, args = [], { env = {}, explicitConfig = true } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...(explicitConfig ? ['--config', ws.config] : []), ...args], {
    cwd: ws.dir,
    env: { ...process.env, CONFIG_FILE: '', OUT_DIR: ws.out, ...env },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

test('init 参数默认预览：呈现更改与示例域名提示，不修改配置、不创建备份', async (t) => {
  const ws = await workspace(t);
  const result = run(ws, ['--title', '我的书库', '--target', 'cloudflare']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /site\.title.*我的书库/);
  assert.match(result.output, /示例域名/);
  assert.match(result.output, /未写入配置/);
  assert.equal(await readFile(ws.config, 'utf8'), ws.text);
  assert.deepEqual(await readdir(ws.dir), ['site.config.yaml']);
});

test('init --write：备份原文件，只更改选定字段，保留注释和自定义配置', async (t) => {
  const custom = '# Owner setup note\n' + TEMPLATE
    .replace(/^ {2}title: .+$/m, '  title: "原有书库" # Owner title note')
    .replace('max_files: 18000', 'max_files: 15000')
    .replace('redirects: []', 'redirects:\n  - { from: /old/, to: /new/, status: 302 }')
    .replace('indexnow_key: ""', 'indexnow_key: "example-key-123456"')
    .replace('X-Content-Type-Options: nosniff', 'X-Content-Type-Options: nosniff\n      X-Template-Check: preserved');
  const ws = await workspace(t, custom);
  const expected = structuredClone(parseSiteConfig(custom));
  expected.site = { ...expected.site, title: '新书库 # 1', domain: 'gallery.unit-fixture.org', lang: 'en' };
  expected.images.hosts = ['images.unit-fixture.org', 'backup.unit-fixture.org'];
  expected.features.text_layer = false;
  expected.features.comimi_reader = true;
  expected.features.platform_config = false;
  expected.deploy.cloudflare.project = 'sample-library';
  const result = run(ws, [
    '--title', expected.site.title, '--domain', 'GALLERY.UNIT-FIXTURE.ORG', '--site-lang', 'en',
    '--image-host', expected.images.hosts[0], '--image-host', expected.images.hosts[1],
    '--text-layer', 'false', '--enhanced-reader', 'true', '--platform-config', 'false',
    '--target', 'cloudflare', '--project', 'sample-library', '--write',
  ]);
  assert.equal(result.status, 0, result.output);
  const saved = await readFile(ws.config, 'utf8');
  assert.deepEqual(parseSiteConfig(saved), expected);
  assert.match(saved, /# Owner setup note/);
  assert.match(saved, /# Owner title note/);
  assert.match(result.output, /发布时仍需.*手动选择目标/);
  const backups = await readdir(ws.backupDir);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(ws.backupDir, backups[0]), 'utf8'), custom);
  assert.deepEqual((await readdir(ws.dir)).sort(), ['out', 'site.config.yaml']);
});

test('init 重复同一配置不重写、不增加备份；UI 英文不改变网站语言', async (t) => {
  const ws = await workspace(t);
  const args = ['--title', 'Stable library', '--ui-lang', 'en', '--write'];
  const first = run(ws, args);
  assert.equal(first.status, 0, first.output);
  const written = await readFile(ws.config, 'utf8');
  const backupNames = await readdir(ws.backupDir);
  const second = run(ws, args);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /Configuration is unchanged/);
  assert.equal(await readFile(ws.config, 'utf8'), written);
  assert.deepEqual(await readdir(ws.backupDir), backupNames);
  assert.equal(parseSiteConfig(written).site.lang, parseSiteConfig(ws.text).site.lang);
});

test('init 错误参数或非法字段非零退出，不写文件或备份', async (t) => {
  const ws = await workspace(t);
  const cases = [
    ['--domain', 'https://gallery.example.org/path', '--write'],
    ['--image-host', 'images.example.org', '--image-host', 'IMAGES.EXAMPLE.ORG', '--write'],
    ['--image-host', 'a.example.org', '--image-host', 'b.example.org', '--image-host', 'c.example.org', '--write'],
    ['--text-layer', 'yes', '--write'],
    ['--title', '  ', '--write'],
    ['--target', 'unknown', '--write'],
    ['--search-function', 'true', '--write'],
    ['--title', 'changed', '--dry-run', '--write'],
  ];
  for (const args of cases) {
    const result = run(ws, args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(await readFile(ws.config, 'utf8'), ws.text);
    assert.deepEqual(await readdir(ws.dir), ['site.config.yaml']);
  }
});

test('init 非 TTY 无参数直接报用法，help 无须有效配置并支持中英文', async (t) => {
  const ws = await workspace(t);
  const missing = join(ws.dir, 'missing.yaml');
  const noInput = run(ws);
  assert.notEqual(noInput.status, 0);
  assert.match(noInput.output, /非交互环境.*参数/);
  for (const [locale, expected] of [['zh', /站点初始化/], ['en', /Pagehaven · Site setup/]]) {
    const result = run(ws, ['--ui-lang', locale, '--help'], { explicitConfig: false, env: { CONFIG_FILE: missing } });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, expected);
    assert.match(result.output, /--write/);
  }
  assert.deepEqual(await readdir(ws.dir), ['site.config.yaml']);
});

test('init 支持 CONFIG_FILE 与独立 cwd，显式 --config 优先且不碰备用文件', async (t) => {
  const ws = await workspace(t);
  const envRun = run(ws, ['--title', 'Environment config', '--write'], { explicitConfig: false, env: { CONFIG_FILE: ws.config } });
  assert.equal(envRun.status, 0, envRun.output);
  assert.equal(parseSiteConfig(await readFile(ws.config, 'utf8')).site.title, 'Environment config');
  const other = join(ws.dir, 'other.yaml');
  await writeFile(other, ws.text);
  const explicit = run(ws, ['--title', 'Explicit config', '--write'], { env: { CONFIG_FILE: other } });
  assert.equal(explicit.status, 0, explicit.output);
  assert.equal(await readFile(other, 'utf8'), ws.text);
  assert.equal(parseSiteConfig(await readFile(ws.config, 'utf8')).site.title, 'Explicit config');
  const defaultFile = join(ROOT, 'site.config.yaml');
  const defaultBefore = await readFile(defaultFile);
  const fallback = run(ws, ['--dry-run'], { explicitConfig: false, env: { CONFIG_FILE: '' } });
  assert.equal(fallback.status, 0, fallback.output);
  assert.match(fallback.output, /配置未变/);
  assert.deepEqual(await readFile(defaultFile), defaultBefore, '空 CONFIG_FILE 回退默认文件时只预览');
  assert.equal(parseSiteConfig(await readFile(ws.config, 'utf8')).site.title, 'Explicit config');
});

test('init 损坏 YAML 不写入，也不在错误日志中回显源文件行', async (t) => {
  const malformed = 'site: [\nprivate-marker-in-invalid-input: [\n';
  const ws = await workspace(t, malformed);
  const result = run(ws, ['--title', 'new title', '--write', '--ui-lang', 'en']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Invalid YAML at line/);
  assert.doesNotMatch(result.output, /private-marker-in-invalid-input/);
  assert.equal(await readFile(ws.config, 'utf8'), malformed);
  assert.deepEqual(await readdir(ws.dir), ['site.config.yaml']);
});

test('init YAML 别名若影响未选字段则拒绝；独立修改保留别名语义', () => {
  const aliased = TEMPLATE.replace(/^ {2}title: .+$/m, '  title: &shared zh-CN').replace('lang: zh-CN', 'lang: *shared');
  assert.equal(parseSiteConfig(aliased).site.title, 'zh-CN');
  assert.throws(() => planInit(aliased, { title: 'Changed title' }), /未选择字段|别名/);
  const plan = planInit(aliased, { domain: 'library.example.org' });
  const expected = parseSiteConfig(aliased);
  expected.site.domain = 'library.example.org';
  assert.deepEqual(parseSiteConfig(plan.text), expected);
  assert.match(plan.text, /\*shared/);
});

test('init 保留 BOM 与 CRLF，未改配置返回原字节，预览示例域名不冒充生产可用', () => {
  const source = '\uFEFF' + TEMPLATE.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
  assert.equal(planInit(source, {}).text, source);
  const preview = planInit(source, { title: '预览书库' }, { target: 'github' });
  assert.ok(preview.text.startsWith('\uFEFF'));
  assert.doesNotMatch(preview.text, /(?<!\r)\n/);
  assert.equal(preview.productionDomainsReady, false);
  const ready = planInit(source, { domain: 'library.unit-fixture.org', 'image-host': ['images.unit-fixture.org'] }, { target: 'edgeone' });
  assert.equal(ready.productionDomainsReady, true);
});

test('init 写入时检测预览后的外部修改，保留新内容并清理自己的锁', async (t) => {
  const ws = await workspace(t);
  const plan = planInit(ws.text, { title: 'Planned change' });
  const newer = ws.text + '\n# Another editor saved this\n';
  await writeFile(ws.config, newer);
  await assert.rejects(writeInitConfig(ws.config, ws.text, plan.text, { backupDir: ws.backupDir }), /已被修改/);
  assert.equal(await readFile(ws.config, 'utf8'), newer);
  assert.deepEqual(await readdir(ws.dir), ['site.config.yaml']);
});

test('init 不抢占现有初始化锁，失败时保留对方锁和原配置', async (t) => {
  const ws = await workspace(t);
  const lock = `${ws.config}.init.lock`;
  await writeFile(lock, 'another process');
  const plan = planInit(ws.text, { title: 'Locked change' });
  await assert.rejects(writeInitConfig(ws.config, ws.text, plan.text, { backupDir: ws.backupDir }), /初始化锁/);
  assert.equal(await readFile(lock, 'utf8'), 'another process');
  assert.equal(await readFile(ws.config, 'utf8'), ws.text);
  assert.equal(existsSync(ws.backupDir), false);
});

test('init 备份目录不可用时原配置不变，临时文件与锁均清理', async (t) => {
  const ws = await workspace(t);
  const blocked = join(ws.dir, 'not-a-directory');
  await writeFile(blocked, 'occupied');
  const plan = planInit(ws.text, { title: 'Cannot save' });
  await assert.rejects(writeInitConfig(ws.config, ws.text, plan.text, { backupDir: blocked }));
  assert.equal(await readFile(ws.config, 'utf8'), ws.text);
  assert.deepEqual((await readdir(ws.dir)).sort(), ['not-a-directory', 'site.config.yaml']);
});

test('init 不用普通文件替换符号链接，也不改链接目标', async (t) => {
  const ws = await workspace(t);
  const link = join(ws.dir, 'linked.yaml');
  try { await symlink(ws.config, link, 'file'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('当前环境不允许创建文件符号链接'); return; }
    throw error;
  }
  const plan = planInit(ws.text, { title: 'No link overwrite' });
  await assert.rejects(writeInitConfig(link, ws.text, plan.text, { backupDir: ws.backupDir }), /符号链接/);
  assert.equal(await readFile(link, 'utf8'), ws.text);
  assert.equal(await readFile(ws.config, 'utf8'), ws.text);
  assert.equal(existsSync(`${link}.init.lock`), false);
});
