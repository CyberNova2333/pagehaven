import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { metaRefresh, redirectOutputPaths } from '../lib/static-output.mjs';
import { ROOT, SITE_GENERATED_DIR } from '../lib/paths.mjs';
import { loadSiteConfig } from '../lib/config.mjs';

test('静态跳转来源映射到输出根内，支持根路径、尾斜线和编码的中文', () => {
  const root = resolve('output-fixture');
  for (const [route, parts] of [['/', []], ['/legacy', ['legacy']], ['/legacy/path/', ['legacy', 'path']],
    ['/旧页', ['旧页']], ['/%E6%97%A7%E9%A1%B5', ['旧页']]]) {
    assert.deepEqual(redirectOutputPaths(root, route), { dir: join(root, ...parts), file: join(root, ...parts, 'index.html') });
  }
});

test('静态跳转拒绝点段、跨平台路径与 URL 解码歧义', () => {
  for (const route of ['/../escaped', '/../../outside', '/a/../b', '/a/.', '/./', '/a//b', '//elsewhere',
    '/a\\..\\outside', '/%2e%2e/outside', '/.%2e/outside', '/a/%2Foutside', '/a/%5coutside',
    '/%252e%252e/outside', '/a/%00b', '/a?query=1', '/a#hash', '/%20', '/a b', '/C:/outside', '/%ZZ', 'relative']) {
    assert.throws(() => redirectOutputPaths(resolve('output-fixture'), route), /规范站内路径/, route);
  }
});

test('静态跳转页对语言属性及目标文本同时转义，普通 URL 和 lang 保持原意', () => {
  const html = metaRefresh('/target?q=one&next="two"', 'zh-CN');
  assert.ok(html.startsWith('<!doctype html><html lang="zh-CN">'));
  assert.ok(html.includes('content="0; url=/target?q=one&amp;next=&quot;two&quot;"'));
  assert.ok(html.includes('href="/target?q=one&amp;next=&quot;two&quot;"'));
  const attack = 'en"><script>window.fixture=1</script><html lang="en';
  const guarded = metaRefresh('/<target>"&', attack);
  assert.ok(!guarded.includes('<script>'));
  assert.ok(!guarded.includes('<target>'));
  assert.ok(guarded.includes('lang="en&quot;>&lt;script>window.fixture=1&lt;/script>&lt;html lang=&quot;en"'));
});

test('build:site 在生成配置和清理 dist 前拒绝不安全重定向', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pagehaven-static-output-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), 'keep existing output');
  const config = structuredClone(await loadSiteConfig());
  config.site.title = '必须在写生成配置前失败';
  config.redirects = [{ from: '/../outside', to: '/', status: 301 }];
  const configFile = join(dir, 'site.config.yaml');
  await writeFile(configFile, JSON.stringify(config));
  const generatedConfig = join(SITE_GENERATED_DIR, 'site-config.json');
  const before = await readFile(generatedConfig, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/build-site.mjs')], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, CONFIG_FILE: configFile, DIST_DIR: dist, OUT_DIR: join(dir, 'missing-out'), DATA_DIR: join(dir, 'missing-data') },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /重定向来源必须是输出目录内的规范站内路径/);
  assert.equal(await readFile(join(dist, 'index.html'), 'utf8'), 'keep existing output');
  assert.equal(await readFile(generatedConfig, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; }), before);
  await assert.rejects(readFile(join(dir, 'outside', 'index.html')), { code: 'ENOENT' });
});
