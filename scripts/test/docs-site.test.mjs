import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = join(ROOT, 'docs-site');
const docsRequire = createRequire(join(DOCS, 'package.json'));
const routes = ['/', '/walkthroughs/one-real-run', '/code-map', '/references/source-evidence', '/references/quality-review', '/change-log'];

test('文档站：真实构建保留引用内容、静态链接与可查询的本地搜索索引', { timeout: 120_000 }, async (t) => {
  let manifest;
  try {
    manifest = docsRequire.resolve('vitepress/package.json');
  } catch {
    assert.fail('文档依赖未安装，请先运行 npm --prefix docs-site ci；根目录 npm ci 不安装独立文档项目');
  }
  const temp = await mkdtemp(join(tmpdir(), 'pagehaven-docs-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dist = join(temp, 'dist');
  // 确保临时产物中的搜索模块按 ESM 加载；不执行浏览器应用脚本。
  await writeFile(join(temp, 'package.json'), '{"type":"module"}\n');
  const bin = join(dirname(manifest), docsRequire(manifest).bin.vitepress);
  const build = spawnSync(process.execPath, [bin, 'build', '--outDir', dist], {
    cwd: DOCS, encoding: 'utf8', timeout: 100_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(build.status, 0, `${build.error ?? ''}\n${build.stdout}\n${build.stderr}`);

  const html = new Map();
  for (const route of routes) {
    const file = route === '/' ? 'index.html' : `${route.slice(1)}.html`;
    const content = await readFile(join(dist, file), 'utf8');
    assert.match(content, /<h1\b/, `${route} 应包含正文而非空外壳`);
    assert.doesNotMatch(content, /<!--\s*@include:/, `${route} 未解析引用正文`);
    html.set(route, content);
  }
  const resolveLink = (href, source) => {
    const url = new URL(href.replaceAll('&amp;', '&'), `https://docs.invalid${source}`);
    if (url.origin !== 'https://docs.invalid') return;
    const target = html.get(url.pathname);
    assert.ok(target, `${source} 中的 ${href} 没有对应静态文档页`);
    if (url.hash) {
      const id = decodeURIComponent(url.hash.slice(1));
      assert.ok(target.includes(`id="${id}"`), `${source} 中的 ${href} 指向不存在的锚点`);
    }
  };
  for (const [route, content] of html) {
    for (const [, href] of content.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) resolveLink(href, route);
  }
  assert.match(html.get('/'), /href="\/walkthroughs\/one-real-run"/, '引用正文里的文档链接必须指向站内路由');
  assert.match(html.get('/code-map'), /仓库文件：<code>scripts\/build-site\.mjs<\/code>/, '源码链接应显示仓库路径，不能重复重定位或成为公开链接');

  const chunks = join(dist, 'assets', 'chunks');
  const indexes = (await readdir(chunks)).filter((file) => /^@localSearchIndexroot\..+\.js$/.test(file));
  assert.equal(indexes.length, 1, '应生成默认语言的本地搜索索引');
  const { default: serialized } = await import(pathToFileURL(join(chunks, indexes[0])).href);
  const MiniSearch = docsRequire('minisearch');
  const search = MiniSearch.loadJSON(serialized, { fields: ['title', 'titles', 'text'], storeFields: ['title', 'titles'] });
  const results = search.search('部署', { prefix: true });
  assert.ok(results.some((hit) => hit.id.startsWith('/walkthroughs/one-real-run#')), '搜索应能找到引用正文里的部署流程');
  for (const result of results) resolveLink(result.id, '/');
  const indexedRoutes = new Set(Object.values(JSON.parse(serialized).documentIds).map((id) => id.split('#')[0]));
  for (const route of routes) assert.ok(indexedRoutes.has(route), `${route} 未进入本地搜索索引`);
});
