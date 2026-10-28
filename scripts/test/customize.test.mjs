// 真 HTTP 请求与隔离配置文件验证维护者工具，不写站点共用生成物或运行构建。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseSiteConfig } from '@gallery/platform';
import { createCustomizer, parseCustomizeArgs, planCustomization, readCustomSettings } from '../lib/customize.mjs';

const TEMPLATE = await readFile(new URL('../../site.config.yaml', import.meta.url), 'utf8');
const TOKEN = 'test-session-only-1234567890';
const FIELD_NAMES = ['title', 'logo', 'tagline', 'theme', 'accent', 'font', 'showSearch', 'showLibrary', 'textLayer', 'enhancedReader'].sort();

async function workspace(t, text = TEMPLATE) {
  const dir = await mkdtemp(join(tmpdir(), 'pagehaven-customize-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'site.config.yaml');
  const backupDir = join(dir, 'backups');
  await writeFile(configFile, text);
  return { dir, configFile, backupDir, text };
}

async function running(t, text = TEMPLATE) {
  const ws = await workspace(t, text);
  const server = createCustomizer({ configFile: ws.configFile, backupDir: ws.backupDir, token: TOKEN });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path = '/api/settings', options = {}) {
    const response = await fetch(origin + path, { ...options, headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers } });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  }
  const save = (body, headers = {}) => request('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
  });
  return { ...ws, server, origin, request, save };
}

test('自定义设置投影仅包含界面字段，缺失的新配置有兼容默认值', () => {
  const raw = yaml.load(TEMPLATE);
  delete raw.site.logo;
  delete raw.site.tagline;
  delete raw.appearance;
  delete raw.features.text_layer;
  delete raw.features.comimi_reader;
  const { settings, revision } = readCustomSettings(yaml.dump(raw));
  assert.deepEqual(Object.keys(settings).sort(), FIELD_NAMES);
  assert.match(revision, /^[0-9a-f]{64}$/);
  assert.equal(settings.logo, '/favicon.svg');
  assert.equal(settings.theme, 'paper');
  assert.equal(settings.enhancedReader, false);
  assert.equal(settings.textLayer, true);
});

test('自定义计划保留注释、BOM、CRLF与未选择字段；未改变设置返回原字节', () => {
  const text = '\uFEFF# Owner appearance note\r\n' + TEMPLATE.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
  const current = readCustomSettings(text);
  assert.equal(planCustomization(text, current.settings).text, text);
  const settings = { ...current.settings, title: '海风书房', logo: '/brand.svg', tagline: '', theme: 'ocean', accent: '#2378ab', font: 'sans', showSearch: false, showLibrary: false, textLayer: false, enhancedReader: true };
  const plan = planCustomization(text, settings);
  assert.ok(plan.text.startsWith('\uFEFF'));
  assert.doesNotMatch(plan.text, /(?<!\r)\n/);
  assert.match(plan.text, /# Owner appearance note/);
  assert.match(plan.text, /# 站点域名/);
  const expected = parseSiteConfig(text);
  expected.site = { ...expected.site, title: settings.title, logo: settings.logo, tagline: '' };
  expected.appearance = { theme: 'ocean', accent: '#2378ab', font: 'sans', show_search: false, show_library: false };
  expected.features.text_layer = false;
  expected.features.comimi_reader = true;
  assert.deepEqual(parseSiteConfig(plan.text), expected);
  assert.equal(plan.changes.length, Object.keys(settings).filter((key) => settings[key] !== current.settings[key]).length);
  assert.deepEqual(readCustomSettings(plan.text).settings, settings);
});

test('自定义设置拒绝缺字段、额外字段、坏类型和会连带修改其他配置的 YAML 别名', () => {
  const { settings } = readCustomSettings(TEMPLATE);
  const missing = { ...settings }; delete missing.theme;
  for (const invalid of [null, [], missing, { ...settings, domain: 'changed.example.org' }, { ...settings, textLayer: 'false' }, { ...settings, accent: 'url(test)' }]) {
    assert.throws(() => planCustomization(TEMPLATE, invalid));
  }
  const aliased = TEMPLATE.replace(/^ {2}title: .+$/m, '  title: &shared zh-CN').replace(/^ {2}lang: .+$/m, '  lang: *shared');
  assert.throws(() => planCustomization(aliased, { ...readCustomSettings(aliased).settings, title: 'Changed title' }), /别名|未选择/);
});

test('自定义 HTTP 读取需有效令牌，不接受查询令牌，不返回非界面配置或开启跨域访问', async (t) => {
  const ws = await running(t);
  for (const [path, headers] of [
    ['/api/settings', { Authorization: '' }],
    ['/api/settings?token=' + TOKEN, { Authorization: '' }],
    ['/api/settings', { Authorization: 'Bearer invalid' }],
  ]) {
    assert.equal((await ws.request(path, { headers })).status, 401);
  }
  const result = await ws.request();
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.data).sort(), ['revision', 'settings']);
  assert.deepEqual(Object.keys(result.data.settings).sort(), FIELD_NAMES);
  assert.equal(Object.hasOwn(result.data, 'config'), false);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await readFile(ws.configFile, 'utf8'), ws.text);
  assert.equal(existsSync(ws.backupDir), false);
});

test('自定义 HTTP 保存校验、保留配置与原文备份；重复保存不重写也不增加备份', async (t) => {
  const original = '# Owner note\n' + TEMPLATE;
  const ws = await running(t, original);
  const current = (await ws.request()).data;
  const settings = { ...current.settings, title: '自定义书房', theme: 'plum', tagline: '', textLayer: false };
  const first = await ws.save({ settings, revision: current.revision });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.changed, true);
  assert.deepEqual(first.data.settings, settings);
  assert.notEqual(first.data.revision, current.revision);
  assert.ok(first.data.changes.some((change) => change.path === 'site.title' && change.before === current.settings.title && change.after === settings.title));
  const saved = await readFile(ws.configFile, 'utf8');
  assert.match(saved, /# Owner note/);
  const before = parseSiteConfig(original);
  const after = parseSiteConfig(saved);
  for (const field of ['images', 'db', 'search', 'headers', 'redirects', 'seo', 'deploy', 'budgets']) assert.deepEqual(after[field], before[field], field);
  const backups = await readdir(ws.backupDir);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(ws.backupDir, backups[0]), 'utf8'), original);
  const again = await ws.save({ settings, revision: first.data.revision });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.data.changed, false);
  assert.deepEqual(again.data.changes, []);
  assert.equal(await readFile(ws.configFile, 'utf8'), saved);
  assert.deepEqual(await readdir(ws.backupDir), backups);
  assert.deepEqual((await readdir(ws.dir)).sort(), ['backups', 'site.config.yaml']);
});

test('自定义 HTTP 拒绝跨源、非 JSON、超限、未知字段与非法设置且不写入', async (t) => {
  const ws = await running(t);
  const current = (await ws.request()).data;
  const body = { ...current, settings: { ...current.settings, title: '拒绝写入' } };
  for (const Origin of ['https://other.example.org', 'null', 'http://127.0.0.1:1']) assert.equal((await ws.save(body, { Origin })).status, 403);
  assert.equal((await ws.save(body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await ws.request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await ws.save({ ...body, unknown: true })).status, 400);
  assert.equal((await ws.save({ ...body, settings: { ...body.settings, file: 'outside.yaml' } })).status, 400);
  assert.equal((await ws.save({ ...body, settings: { ...body.settings, logo: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await ws.save({ ...body, settings: { ...body.settings, title: 'x'.repeat(17 * 1024) } })).status, 413);
  assert.equal((await ws.request('/api/settings', { method: 'DELETE' })).status, 405);
  assert.equal((await ws.request('/api/files')).status, 404);
  assert.equal(await readFile(ws.configFile, 'utf8'), ws.text);
  assert.equal(existsSync(ws.backupDir), false);
});

test('自定义 HTTP 不覆盖已变配置，旧版本与并发保存返回冲突', async (t) => {
  const ws = await running(t);
  const current = (await ws.request()).data;
  const externallyEdited = ws.text + '\n# Another editor saved this\n';
  await writeFile(ws.configFile, externallyEdited);
  const stale = await ws.save({ ...current, settings: { ...current.settings, title: 'Stale edit' } });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(await readFile(ws.configFile, 'utf8'), externallyEdited);
  assert.equal(existsSync(ws.backupDir), false);
  const latest = (await ws.request()).data;
  const saves = await Promise.all(['First editor', 'Second editor'].map((title) => ws.save({ ...latest, settings: { ...latest.settings, title } })));
  assert.deepEqual(saves.map((result) => result.status).sort(), [200, 409]);
  const winner = saves.find((result) => result.status === 200);
  assert.equal(parseSiteConfig(await readFile(ws.configFile, 'utf8')).site.title, winner.data.settings.title);
  assert.equal((await readdir(ws.backupDir)).length, 1);
});

test('自定义 HTTP 保留其他进程的配置锁，不泄露损坏源文件内容', async (t) => {
  const ws = await running(t);
  const current = (await ws.request()).data;
  const lock = `${ws.configFile}.init.lock`;
  await writeFile(lock, 'other editor');
  const result = await ws.save({ ...current, settings: { ...current.settings, title: 'Locked save' } });
  assert.equal(result.status, 409, result.text);
  assert.equal(await readFile(lock, 'utf8'), 'other editor');
  assert.equal(await readFile(ws.configFile, 'utf8'), ws.text);
  await writeFile(ws.configFile, 'site: [\nprivate-marker-in-invalid-input: [\n');
  const broken = await ws.request();
  assert.equal(broken.status, 500);
  assert.doesNotMatch(broken.text, /private-marker-in-invalid-input/);
});

test('自定义工具仅提供固定静态资源，页面不内嵌会话令牌；CLI拒绝错误监听参数', async (t) => {
  const ws = await running(t);
  const page = await ws.request('/');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, new RegExp(TOKEN));
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await ws.request('/site.config.yaml')).status, 404);
  assert.equal((await ws.request('/../package.json')).status, 404);
  assert.throws(() => createCustomizer({ configFile: ws.configFile, backupDir: ws.backupDir, token: '' }));
  assert.equal(parseCustomizeArgs([]).host, '127.0.0.1');
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port', '12.3'], ['--config', ''], ['--unknown']]) assert.throws(() => parseCustomizeArgs(args));
});
