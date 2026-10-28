// 站点构建的端到端测试：拿测试样本真跑 build:config → build:db → build:site（astro build）→ build:index →
// build:sitemap，再让 check 守卫过一遍产物。不 mock 任何一步——每话恰好一个 HTML、台词在 HTML 里、
// 索引与 sitemap 的形状，这些只有真构建出来才算数。
//
// CONFIG_FILE / DATA_DIR / DIST_DIR / OUT_DIR 全指到样本与临时目录，不修改站点源配置。
// 唯一会写进仓库的是 packages/site/src/generated/（不入库、每次构建重生成）与
// packages/platform/generated/（build:config 的输出；内容与入库的一致，等于没改）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SiteConfigSchema } from '@gallery/platform';
import { appearanceVariables } from '../../packages/site/src/lib/site-appearance.js';
import { loadSiteConfig } from '../lib/config.mjs';
import { loadGallery } from '../lib/data.mjs';
import { buildManifest } from '../lib/manifest.mjs';
import { releaseFingerprint } from '../lib/release.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const SITE_DIR = join(ROOT, 'packages', 'site');
/** 站点生成物目录：build:site 写、astro build 读；下面有几个用例会动它里面的文件再直接跑 astro。 */
const GENERATED = join(SITE_DIR, 'src', 'generated');
// 用户可在自定义工具中关闭文字层/导航或开启增强分页；测试的基线场景由快照明确规定，
// 不依赖维护者当前的开关选择。其余配置仍取当前站点，另固定无须 HTML 转义的测试标题。
const config = structuredClone(await loadSiteConfig());
config.site.title = '构建测试书房';
Object.assign(config.features, { text_layer: true, comimi_reader: false, platform_config: true });
Object.assign(config.appearance, { show_search: true, show_library: true });
const siteOrigin = `https://${config.site.domain}`;
const imageOrigin = `https://${config.images.hosts[0]}`;

function run(script, env) {
  const clean = { ...process.env };
  for (const key of ['CONFIG_FILE', 'DATA_DIR', 'DIST_DIR', 'OUT_DIR', 'DEPLOY_ENV', 'RELEASE_VERSION']) delete clean[key];
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], { cwd: ROOT, encoding: 'utf8', env: { ...clean, ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function configSnapshot(dir) {
  const file = join(dir, 'site.config.yaml');
  // JSON 是合法 YAML，避免在测试里维护第二份配置模板或字段清单。
  await writeFile(file, JSON.stringify(config));
  return file;
}

// 跳过 build-site.mjs、直接跑 astro build：用来验证「生成物与 gallery.json 对不上」这类只有绕过流水线
// 才会出现的状态。astro 的 bin 与 build-site.mjs 同样从包自己的声明取，不依赖 PATH。
const require = createRequire(import.meta.url);
const astroPkg = require.resolve('astro/package.json');
const ASTRO_BIN = join(dirname(astroPkg), require(astroPkg).bin.astro);
function astroBuild(outDir) {
  const r = spawnSync(process.execPath, [ASTRO_BIN, 'build', '--outDir', outDir], { cwd: SITE_DIR, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** 从 HTML 里取某个属性的 JSON 值（Astro 把 " 写成 &quot;）。 */
function jsonAttr(html, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(html);
  assert.ok(m, `缺 ${name} 属性`);
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#34;/g, '"'));
}

async function walk(dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

// 沿阅读器自己的同源 JS 引用查找静态与懒加载 chunk；不能扫描整个 _astro，搜索页也在同一产物中。
async function readerChunks(dist, html) {
  const roots = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
  const inline = [...html.matchAll(/<script\b(?=[^>]*\btype="module")(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(roots.length + inline.length > 0, '阅读器应包含构建后的浏览器模块');
  for (const [tag, src] of roots) {
    assert.match(tag, /\btype="module"/, '增强分页脚本应为 module');
    assert.match(src, /^\/_astro\/[^?#]+\.js$/, '增强分页脚本应来自本站静态产物');
  }
  const pending = roots.map(([, src]) => src);
  const seen = new Set();
  const chunks = [...inline];
  for (const chunk of inline) {
    for (const [, src] of chunk.matchAll(/["'](\/_astro\/[^"'\s]+\.js)["']/g)) pending.push(src);
  }
  while (pending.length) {
    const src = pending.pop();
    if (seen.has(src)) continue;
    seen.add(src);
    assert.ok(src.startsWith('/_astro/'), '模块依赖必须留在本站构建目录内');
    const text = await readFile(join(dist, src.slice(1)), 'utf8');
    chunks.push(text);
    // Vite 的 import/export 与预加载映射均使用带引号的相对 JS 路径。
    for (const [, specifier] of text.matchAll(/["']((?:\.{1,2}\/|\/_astro\/)[^"'\s]+\.js)["']/g)) {
      pending.push(new URL(specifier, `https://static.invalid${src}`).pathname);
    }
  }
  return chunks.join('\n');
}

test('站点配置：trigram 最短 MATCH 长度固定为 3，拒绝会漏掉两字结果的设置', () => {
  assert.equal(SiteConfigSchema.safeParse(config).success, true);
  assert.equal(config.search.min_match_length, 3);
  for (const min_match_length of [1, 2, 4]) {
    const result = SiteConfigSchema.safeParse({ ...config, search: { ...config.search, min_match_length } });
    assert.equal(result.success, false);
    assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'search.min_match_length'));
  }
});

test('站点构建：样本数据 → 每话一 HTML + 索引分片 + sitemap，守卫通过', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-site-'));
  const DIST = join(tmp, 'dist');
  const env = { CONFIG_FILE: await configSnapshot(tmp), DATA_DIR: FIXTURES, DIST_DIR: DIST, OUT_DIR: join(tmp, 'out'), RELEASE_VERSION: 'site-build-test' };
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const model = await loadGallery({ dataDir: FIXTURES, imagePrefix: config.images.prefix });
  await mkdir(env.OUT_DIR, { recursive: true });
  await writeFile(join(env.OUT_DIR, 'manifest.json'), JSON.stringify(buildManifest(model, config, { version: env.RELEASE_VERSION })));

  // 预先放一份「上次构建留下、如今已从 data/ 撤掉的话」的分片：build:site 声称 text/ 先整个删掉再写，
  // 构建完它必须不在——否则撤掉的话还能被 glob 到。
  const staleShard = join(GENERATED, 'text', 'stale', 'v', 'c.json');
  await mkdir(dirname(staleShard), { recursive: true });
  await writeFile(staleShard, '{"chapter":"stale/v/c","pages":[]}\n');

  for (const script of ['build-config.mjs', 'build-db.mjs', 'build-site.mjs', 'build-index.mjs', 'build-sitemap.mjs']) {
    const r = run(script, env);
    assert.equal(r.status, 0, `${script} 失败：\n${r.out}`);
  }

  const manifest = JSON.parse(await readFile(join(env.OUT_DIR, 'manifest.json'), 'utf8'));

  await t.test('每话恰好一个 HTML，且是该目录下唯一的 HTML', async () => {
    for (const key of ['sample/vol01/c001', 'sample/vol01/c002', 'sample/vol02/c003', 'zeta/v1/ch1']) {
      const dir = join(DIST, ...key.split('/'));
      assert.ok(existsSync(join(dir, 'index.html')), `${key}/index.html 不存在`);
      const htmls = (await walk(dir)).filter((f) => extname(f) === '.html');
      assert.equal(htmls.length, 1, `${key} 下的 HTML：${htmls.join(', ')}`);
    }
    // 作品页、期页、首页、搜索页、个人书架、404
    for (const p of ['index.html', '404.html', 'search/index.html', 'library/index.html', 'sample/index.html', 'sample/vol01/index.html', 'zeta/v1/index.html']) {
      assert.ok(existsSync(join(DIST, p)), `${p} 不存在`);
    }
    // 没有图片、没有 DB。搜索页的执行器是懒加载 chunk（sqlite-wasm 的 wasm 与 worker 代理
    // 也只能是独立文件），放在 dist/_astro/ 下；话目录里不许出现独立 JS/CSS。
    // 页码书签与书架共享同源模块，检查真实依赖图，不能再把所有 _astro 引用当成检索执行器。
    const files = await walk(DIST);
    const bad = files.filter((f) => ['.avif', '.webp', '.png', '.jpg', '.sqlite'].includes(extname(f)));
    assert.deepEqual(bad, []);
    for (const key of ['sample/vol01/c001', 'sample/vol01/c002', 'sample/vol02/c003', 'zeta/v1/ch1']) {
      const dir = join(DIST, ...key.split('/'));
      const stray = (await walk(dir)).filter((f) => ['.js', '.css', '.wasm'].includes(extname(f)));
      assert.deepEqual(stray, [], `${key} 下不该有独立 JS/CSS/wasm`);
      const html = await readFile(join(dir, 'index.html'), 'utf8');
      const modules = await readerChunks(DIST, html);
      assert.doesNotMatch(modules, /sqlite|search-config|search-form|search-results|createMangaViewer|comimi/i,
        `${key} 的书签模块不能带入检索执行器或默认关闭的增强分页`);
      assert.doesNotMatch(html, /id="enhanced-(?:option|toggle|viewer|status)"/, `${key} 默认不输出增强分页控件或容器`);
    }
  });

  await t.test('静态页面使用当前品牌与外观配置，产物不包含维护者编辑器或配置接口', async () => {
    for (const page of ['index.html', 'sample/vol01/c001/index.html']) {
      const html = await readFile(join(DIST, page), 'utf8');
      const iconTag = html.match(/<link\b(?=[^>]*\brel="icon")[^>]*>/)?.[0] ?? '';
      assert.ok(iconTag.includes(`href="${config.site.logo.replaceAll('&', '&amp;')}"`), 'favicon 应使用已配置 Logo');
      const rootStyle = /<html\b[^>]*\bstyle="([^"]*)"/.exec(html)?.[1] ?? '';
      assert.ok(rootStyle.replaceAll(' ', '').includes(`--accent:${appearanceVariables(config.appearance)['--accent']};`), '页面应使用已配置主色');
      if (config.site.tagline) assert.ok(html.includes(config.site.tagline.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')), '页脚应使用已配置文案');
      assert.doesNotMatch(html, /\/api\/settings|customize\.(?:js|css)|#token=/);
    }
    const reader = await readFile(join(DIST, 'sample/vol01/c001/index.html'), 'utf8');
    assert.ok(reader.includes(`data-site-logo="${config.site.logo.replaceAll('&', '&amp;')}"`), '增强阅读器应取得同一个 Logo');
    assert.equal(existsSync(join(DIST, 'api', 'settings')), false);
    assert.equal(existsSync(join(DIST, 'customize')), false);
    for (const file of await walk(DIST)) assert.doesNotMatch(file, /[\\/]customize\.(?:js|css|html)$/);
  });

  await t.test('静态产物保留增强分页组件的许可证', async () => {
    const license = await readFile(join(SITE_DIR, 'public', 'licenses', 'comimi.txt'), 'utf8');
    const originalLicense = await readFile(join(ROOT, 'node_modules', '@yui540', 'comimi', 'LICENSE'), 'utf8');
    assert.equal(license.replace(/\r\n/g, '\n'), originalLicense.replace(/\r\n/g, '\n'),
      '随站点分发的许可证必须保留依赖的完整版权与许可声明');
    assert.equal(
      await readFile(join(DIST, 'licenses', 'comimi.txt'), 'utf8'),
      license,
    );
  });

  await t.test('阅读器 HTML：台词、webp URL、上下话链接、#p 脚本、文字层高亮 id', async () => {
    const html = await readFile(join(DIST, 'sample', 'vol01', 'c001', 'index.html'), 'utf8');
    // 台词是普通 DOM 文本
    assert.ok(html.includes('你好，世界！'), '台词文本不在 HTML 里');
    assert.ok(html.includes('漫画作者的契約'), '第二个框的台词不在 HTML 里');
    assert.ok(html.includes('id="p1b0"') && html.includes('id="p1b1"'), '框的 id 应是 p<n>b<i>');
    assert.ok(html.includes('id="p2b0"'), '点标签（w=h=0）也应有框');
    assert.match(html, /class="box dot[^"]*"[^>]*id="p2b0"/, 'w=h=0 的框应带 dot 类');
    // 三页的 <img src=webp>，域名取 images.hosts[0]
    for (const [n, hash] of [[1, '0123456789ab'], [2, '123456789abc'], [3, '23456789abcd']]) {
      assert.ok(html.includes(`${imageOrigin}/${config.images.prefix}sample/vol01/c001/${n}-${hash}.webp`), `第 ${n} 页 webp URL`);
      assert.ok(!html.includes(`${imageOrigin}/${config.images.prefix}sample/vol01/c001/${n}-${hash}.avif`), `第 ${n} 页不该再有 avif`);
      assert.ok(html.includes(`id="p${n}"`), `第 ${n} 页的锚点`);
    }
    const imageTags = html.match(/<img\b[^>]*>/g) ?? [];
    assert.equal(imageTags.filter((tag) => tag.includes(`src="${imageOrigin}/`)).length, 3, '三页都在这一份 HTML 里');
    assert.doesNotMatch(html, /<source type="image\/avif"/);
    assert.ok(imageTags.some((tag) => tag.includes(`src="${imageOrigin}/`) && /\.webp"/.test(tag)));
    assert.match(html, /loading="lazy"/);
    assert.match(html, /width="1200" height="1700"/);
    assert.ok(html.includes('aspect-ratio:2400/1700'), '宽页的纵横比');
    // 上一话 / 下一话：c001 是第一话，只有下一话
    assert.ok(html.includes('href="/sample/vol01/c002/"'), '下一话链接');
    assert.ok(html.includes('rel="next"'));
    assert.ok(!html.includes('rel="prev"'), '第一话不该有上一话');
    // 翻页脚本：#p<n> 与 #p<n>b<i> 解析、replaceState、键盘
    assert.ok(html.includes('#p(\\d+)(?:b(\\d+))?'), 'hash 解析正则');
    assert.ok(html.includes('replaceState'));
    assert.ok(html.includes('ArrowLeft') && html.includes('ArrowRight'));
    // 图片失败切源的脚本读 data-hosts
    assert.deepEqual(jsonAttr(html, 'data-hosts'), config.images.hosts);
    // 阅读页保持固定数量导航，不再把其他期的完整目录重复塞进每一话。
    assert.ok(!html.includes('href="/sample/vol02/c003/"'), '远端章节目录应在打开时读取索引');
    assert.match(html, /data-series-id="sample"/);
    assert.match(html, /data-chapter-key="sample\/vol01\/c001"/);
    assert.match(html, /<noscript>[\s\S]*?href="\/sample\/"[\s\S]*?href="\/sample\/vol01\/"[\s\S]*?<\/noscript>/);
    assert.equal((html.match(/class="image-feedback" hidden/g) ?? []).length, 3, '无 JS 时图片反馈隐藏，原生图片仍可读');
    assert.match(html, /<\w+\b(?=[^>]*\bid="reader-bookmarks")(?=[^>]*\bhidden(?:\s|[=>]))[^>]*>/, '书签操作仅在脚本初始化后启用');
    for (const attr of ['data-bookmark-page', 'data-bookmark-toggle', 'data-bookmark-edit', 'data-bookmark-editor', 'data-bookmark-note', 'data-bookmark-save', 'data-bookmark-cancel', 'data-bookmark-message']) {
      assert.ok(html.includes(attr), `阅读器书签缺 ${attr}`);
    }
    assert.match(html, /<textarea\b(?=[^>]*\bdata-bookmark-note(?:\s|[=>]))(?=[^>]*\bmaxlength="200")[^>]*>/, '书签备注输入框上限应与存储校验一致');
    // 外壳
    assert.equal(/<html\b[^>]*\blang="([^"]+)"/.exec(html)?.[1], config.site.lang);
    assert.ok(html.includes(`<link rel="canonical" href="${siteOrigin}/sample/vol01/c001/">`));
    assert.ok(html.includes(`<meta property="og:title" content="第一话 开端 · 第一卷 · 示例作品 · ${config.site.title}">`));

    // 跨期的上一话：c003（第二卷）的上一话是 c002（第一卷）
    const html3 = await readFile(join(DIST, 'sample', 'vol02', 'c003', 'index.html'), 'utf8');
    assert.ok(html3.includes('rel="prev" href="/sample/vol01/c002/"'));
    assert.ok(!html3.includes('rel="next"'));
  });

  await t.test('没有台词稿的话：页面正常、没有文字层', async () => {
    const html = await readFile(join(DIST, 'sample', 'vol02', 'c003', 'index.html'), 'utf8');
    assert.ok(html.includes(`${imageOrigin}/${config.images.prefix}sample/vol02/c003/1-56789abcdef0.webp`));
    assert.ok(!html.includes('class="text-layer'), '不该有文字层');
    assert.ok(!/id="p\d+b\d+"/.test(html), '不该有框');
    assert.ok(html.includes('id="p1"'));
  });

  await t.test('首页 / 作品页 / 期页 / 搜索页', async () => {
    const home = await readFile(join(DIST, 'index.html'), 'utf8');
    assert.ok(home.includes('href="/search/"'));
    const zetaAt = home.indexOf('href="/zeta/"');
    const sampleAt = home.indexOf('href="/sample/"');
    assert.ok(zetaAt >= 0 && sampleAt >= 0 && zetaAt < sampleAt, '作品按模型顺序（zeta sort=0 在前）');
    const series = await readFile(join(DIST, 'sample', 'index.html'), 'utf8');
    assert.ok(series.includes('href="/sample/vol01/"') && series.includes('href="/sample/vol02/"'));
    assert.ok(series.includes('2026-01-01'), '期的 published');
    const issue = await readFile(join(DIST, 'sample', 'vol01', 'index.html'), 'utf8');
    assert.ok(issue.includes('href="/sample/vol01/c001/"') && issue.includes('href="/sample/vol01/c002/"'));
    assert.ok(issue.includes('有台词'), '有台词稿的话在期页标「有台词」');
    const issue2 = await readFile(join(DIST, 'sample', 'vol02', 'index.html'), 'utf8');
    assert.ok(!issue2.includes('有台词'), '没有台词稿的话不标');
    const search = await readFile(join(DIST, 'search', 'index.html'), 'utf8');
    for (const id of ['search-form', 'search-input', 'search-results', 'search-status', 'search-config', 'search-series', 'search-more', 'search-coverage']) {
      assert.ok(search.includes(`id="${id}"`), `搜索页缺 #${id}`);
    }
    const m = /<script type="application\/json" id="search-config">(.*?)<\/script>/.exec(search);
    assert.ok(m, 'search-config JSON');
    const cfg = JSON.parse(m[1]);
    assert.deepEqual(cfg.images.hosts, config.images.hosts);
    assert.equal(cfg.search.request_chunk_size, cfg.db.page_size);
    assert.deepEqual(cfg.db.release, manifest.db, '页面固定绑定同次构建的检索库');
    assert.deepEqual(cfg.coverage, { chapters: 4, withText: 3, boxes: 5 });
    const notFound = await readFile(join(DIST, '404.html'), 'utf8');
    assert.ok(notFound.includes('<meta name="robots" content="noindex">'));
    assert.ok(!notFound.includes('rel="canonical"'));
  });

  await t.test('个人书架：独立静态页面、最小目录、作品操作与全站入口，私人内容不索引', async () => {
    const library = await readFile(join(DIST, 'library', 'index.html'), 'utf8');
    for (const id of ['library-root', 'library-catalog', 'library-list', 'library-filter', 'library-search', 'library-count', 'library-empty', 'library-storage-note', 'library-bookmarks', 'bookmark-count', 'bookmark-list', 'bookmark-empty', 'bookmark-storage-note', 'bookmark-filter']) {
      assert.ok(library.includes(`id="${id}"`), `书架页缺 #${id}`);
    }
    assert.match(library, /<select\b(?=[^>]*\bid="bookmark-filter")[^>]*>/, '集中书签应提供作品筛选');
    assert.ok(library.includes('<meta name="robots" content="noindex">'));
    assert.ok(!library.includes('rel="canonical"'), '书架不应声明公开内容 canonical');
    assert.ok(!library.includes('property="og:url"'));
    assert.match(library, /<noscript>[\s\S]*?书架[\s\S]*?<\/noscript>/, '禁用脚本时要解释书架的使用条件');
    const json = /<script\b(?=[^>]*\bid="library-catalog")(?=[^>]*\btype="application\/json")[^>]*>([\s\S]*?)<\/script>/.exec(library);
    assert.ok(json, '书架目录应使用 application/json 数据块');
    const catalog = JSON.parse(json[1]);
    assert.deepEqual(catalog.map((series) => series.id), ['zeta', 'sample']);
    const sample = catalog.find((series) => series.id === 'sample');
    assert.equal(sample.title, '示例作品');
    assert.equal(sample.url, '/sample/');
    assert.equal(sample.coverUrl, null);
    assert.deepEqual(sample.authors, []);
    assert.deepEqual(sample.issues.map((issue) => issue.id), ['vol01', 'vol02']);
    assert.deepEqual(sample.issues[0].chapters[0], {
      key: 'sample/vol01/c001', title: '第一话 开端', url: '/sample/vol01/c001/', pages: 3,
    });
    assert.equal(catalog.flatMap((series) => series.issues.flatMap((issue) => issue.chapters)).length, 4);
    assert.ok(!json[1].includes('你好，世界！'), '书架目录不应携带台词正文');
    assert.ok(!json[1].includes('0123456789ab'), '恢复进度只需要章节页数，不重复携带每页图片信息');

    const series = await readFile(join(DIST, 'sample', 'index.html'), 'utf8');
    assert.match(series, /<\w+\b(?=[^>]*\bid="series-library")(?=[^>]*\bdata-series-id="sample")(?=[^>]*\bhidden(?:\s|[=>]))[^>]*>/, '作品书架控件仅在脚本初始化后启用');
    for (const attr of ['data-library-add', 'data-library-status', 'data-library-remove', 'data-library-message']) {
      assert.ok(series.includes(attr), `作品书架控件缺 ${attr}`);
    }
    for (const page of ['index.html', 'library/index.html', 'sample/index.html', 'sample/vol01/c001/index.html']) {
      const html = await readFile(join(DIST, page), 'utf8');
      assert.ok((html.match(/href="\/library\/"/g) ?? []).length >= 2, `${page} 的导航与页脚均需提供书架入口`);
    }
    const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
    assert.ok(!sitemap.includes('/library/'), '个人书架不进入公开内容 sitemap');
  });

  await t.test('index/ 分片', async () => {
    const summary = JSON.parse(await readFile(join(DIST, 'index', 'series.json'), 'utf8'));
    assert.deepEqual(
      summary.map((s) => ({ id: s.id, title: s.title, url: s.url, issues: s.issues, chapters: s.chapters })),
      [
        { id: 'zeta', title: '终章短篇', url: '/zeta/', issues: 1, chapters: 1 },
        { id: 'sample', title: '示例作品', url: '/sample/', issues: 2, chapters: 3 },
      ],
    );
    // 元数据检索用的字段（样本没有元数据，给空数组 / null）
    assert.deepEqual(summary[1].authors, []);
    assert.deepEqual(summary[1].tags, []);
    assert.equal(summary[1].coverKey, null);
    const shard = JSON.parse(await readFile(join(DIST, 'index', 'sample.json'), 'utf8'));
    assert.equal(shard.id, 'sample');
    assert.equal(shard.title, '示例作品');
    assert.deepEqual(shard.issues.map((i) => [i.id, i.number, i.published, i.url]), [
      ['vol01', 1, '2026-01-01', '/sample/vol01/'],
      ['vol02', 2, '2026-06-01', '/sample/vol02/'],
    ]);
    assert.deepEqual(shard.issues[0].chapters[0], {
      id: 'c001', number: 1, title: '第一话 开端', url: '/sample/vol01/c001/', key: 'sample/vol01/c001', pages: 3, hasText: true,
    });
    assert.equal(shard.issues[1].chapters[0].hasText, false);
    const zeta = JSON.parse(await readFile(join(DIST, 'index', 'zeta.json'), 'utf8'));
    assert.equal(zeta.issues[0].published, null, '没有 published 写 null');
  });

  await t.test('sitemap.xml 与 robots.txt', async () => {
    const xml = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
    assert.ok(xml.includes(`<loc>${siteOrigin}/</loc>`));
    assert.ok(xml.includes(`<loc>${siteOrigin}/search/</loc>`));
    assert.ok(xml.includes(`<loc>${siteOrigin}/sample/</loc>`));
    assert.ok(xml.includes(`<url><loc>${siteOrigin}/sample/vol01/</loc><lastmod>2026-01-01</lastmod></url>`));
    assert.ok(xml.includes(`<url><loc>${siteOrigin}/sample/vol01/c001/</loc><lastmod>2026-01-01</lastmod></url>`));
    assert.ok(xml.includes(`<url><loc>${siteOrigin}/sample/vol02/c003/</loc><lastmod>2026-06-01</lastmod></url>`));
    assert.ok(xml.includes(`<url><loc>${siteOrigin}/zeta/v1/ch1/</loc></url>`), '没有 published 的期不出 lastmod');
    // 2 固定 + 2 作品 + 3 期 + 4 话
    assert.equal((xml.match(/<url>/g) ?? []).length, 11);
    const robots = await readFile(join(DIST, 'robots.txt'), 'utf8');
    assert.equal(robots, `User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin}/sitemap.xml\n`);
  });

  await t.test('站点生成物：gallery.json 不含台词，text/ 按话分片，过期分片被清掉', async () => {
    const gen = GENERATED;
    const gallery = JSON.parse(await readFile(join(gen, 'gallery.json'), 'utf8'));
    assert.deepEqual(gallery.totals, { series: 2, issues: 3, chapters: 4, pages: 8, boxes: 5 });
    assert.deepEqual(gallery.searchDb, manifest.db);
    assert.deepEqual(JSON.parse(await readFile(join(DIST, 'release.json'), 'utf8')), { version: manifest.version, fingerprint: releaseFingerprint(manifest), environment: 'production' });
    const pagesInGallery = gallery.series.flatMap((s) => s.issues.flatMap((i) => i.chapters.flatMap((c) => c.pages)));
    assert.equal(pagesInGallery.length, 8);
    assert.ok(pagesInGallery.every((pg) => !('boxes' in pg) && pg.keys.webp), 'gallery.json 的页只有结构与图片 key，不含 boxes');
    const text = JSON.parse(await readFile(join(gen, 'text', 'sample', 'vol01', 'c001.json'), 'utf8'));
    assert.equal(text.chapter, 'sample/vol01/c001');
    assert.deepEqual(text.pages.map((p) => p.n), [1, 2], '只写有框的页');
    assert.deepEqual(text.pages[0].boxes[0], { i: 0, x: 0.12, y: 0.08, w: 0.2, h: 0.15, t: '你好，世界！' });
    assert.ok(!existsSync(join(gen, 'text', 'sample', 'vol02', 'c003.json')), '没有台词稿的话不写分片');
    assert.ok(!existsSync(staleShard), '构建前放进去的过期分片应被 rm -rf text/ 清掉');
    assert.ok(!existsSync(join(gen, 'text', 'stale')), '过期分片的目录也不该留');
  });

  await t.test('check 守卫对这套产物退出码 0', () => {
    const r = run('check.mjs', env);
    assert.equal(r.status, 0, r.out);
  });

  await t.test('输入数据摘要不符时拒绝搭配旧检索库，保留已有 dist', async () => {
    const outDir = join(tmp, 'out-stale');
    const rejectedDist = join(tmp, 'dist-stale');
    await mkdir(outDir);
    await mkdir(rejectedDist);
    await writeFile(join(rejectedDist, 'keep.txt'), 'existing');
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ ...manifest, sourceSha256: '0'.repeat(64) }));
    const r = run('build-site.mjs', { ...env, OUT_DIR: outDir, DIST_DIR: rejectedDist });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /站点数据与检索库构建清单不一致/);
    assert.equal(await readFile(join(rejectedDist, 'keep.txt'), 'utf8'), 'existing');
  });

  await t.test('预览构建：所有普通页面 noindex，不输出生产 canonical 与 og:url', async () => {
    const cfgFile = join(GENERATED, 'site-config.json');
    const saved = await readFile(cfgFile);
    try {
      const out = join(tmp, 'dist-preview');
      const r = run('build-site.mjs', { ...env, DIST_DIR: out, DEPLOY_ENV: 'preview' });
      assert.equal(r.status, 0, r.out);
      assert.equal(JSON.parse(await readFile(cfgFile, 'utf8')).preview, true);
      for (const page of ['index.html', 'search/index.html', 'sample/index.html', 'sample/vol01/c001/index.html']) {
        const html = await readFile(join(out, page), 'utf8');
        assert.ok(html.includes('<meta name="robots" content="noindex">'), `${page} 缺少 noindex`);
        assert.ok(!html.includes('rel="canonical"'), `${page} 不该声明生产 canonical`);
        assert.ok(!html.includes('property="og:url"'), `${page} 不该声明生产 og:url`);
      }
      assert.deepEqual(JSON.parse(await readFile(join(out, 'release.json'), 'utf8')), { version: manifest.version, fingerprint: releaseFingerprint(manifest), environment: 'preview' });
    } finally {
      await writeFile(cfgFile, saved);
    }
  });

  // 下面的用例改动 src/generated/ 里的文件再直接跑 astro build，跑完原样放回：
  // 这个目录是共享的构建中间态，不能留下与 gallery.json 对不上的东西。

  await t.test('features.comimi_reader 开：可选同源模块保留原图片、文字层与每话一 HTML', async () => {
    const cfgFile = join(GENERATED, 'site-config.json');
    const saved = await readFile(cfgFile, 'utf8');
    try {
      const cfg = JSON.parse(saved);
      cfg.features.comimi_reader = true;
      cfg.features.platform_config = false;
      await writeFile(cfgFile, JSON.stringify(cfg));
      const out = join(tmp, 'dist-enhanced-reader');
      const r = astroBuild(out);
      assert.equal(r.status, 0, r.out);
      for (const chapter of model.chapters) {
        const dir = join(out, ...chapter.key.split('/'));
        assert.deepEqual((await walk(dir)).filter((file) => extname(file) === '.html'), [join(dir, 'index.html')]);
        const html = await readFile(join(dir, 'index.html'), 'utf8');
        assert.match(html, /<input\b(?=[^>]*\bid="enhanced-toggle")(?=[^>]*\btype="checkbox")[^>]*>/);
        assert.match(html, /<div\b(?=[^>]*\bid="enhanced-viewer")(?=[^>]*\bhidden(?:\s|[=>]))[^>]*>/);
        const pages = [...html.matchAll(/<section\b[^>]*\bclass="page"[^>]*>([\s\S]*?)<\/section>/g)];
        assert.equal(pages.length, chapter.pages.length, `${chapter.key} 的原阅读器页不能被替换为空容器`);
        for (const [index, page] of pages.entries()) {
          assert.ok(page[1].includes(`src="${imageOrigin}/${chapter.pages[index].keys.webp}"`), '原图片仍在 HTML 中');
        }
        const modules = await readerChunks(out, html);
        assert.doesNotMatch(modules, /sqlite|search-config|search-form|search-results/i, '阅读器的模块依赖不应包含检索执行器');
      }
      const html = await readFile(join(out, 'sample', 'vol01', 'c001', 'index.html'), 'utf8');
      assert.match(html, /class="text-layer"/);
      for (const id of ['p1b0', 'p1b1', 'p2b0']) assert.ok(html.includes(`id="${id}"`), `保留台词框 ${id}`);
      assert.ok(html.includes('你好，世界！') && html.includes('漫画作者的契約'), '文字内容仍是普通 DOM 文本');
      assert.match(html, /class="box dot[^"]*"[^>]*id="p2b0"/, '点标签也保留');
      assert.ok(existsSync(join(out, 'licenses', 'comimi.txt')), '增强模式产物也应附带许可证');
    } finally {
      await writeFile(cfgFile, saved);
    }
  });

  await t.test('hasText 但分片缺失：astro build 报错退出、信息含该话 key，而不是静默丢掉文字层', async () => {
    const shard = join(GENERATED, 'text', 'sample', 'vol01', 'c001.json');
    const saved = await readFile(shard);
    await rm(shard);
    try {
      const r = astroBuild(join(tmp, 'dist-missing-shard'));
      assert.notEqual(r.status, 0, `astro build 应该失败：\n${r.out}`);
      assert.match(r.out, /sample\/vol01\/c001/, '错误信息应指出是哪一话');
      assert.match(r.out, /hasText/);
    } finally {
      await writeFile(shard, saved);
    }
  });

  await t.test('两条图片域名：切源脚本读到两个 host，图片 URL 仍取第一条', async () => {
    const cfgFile = join(GENERATED, 'site-config.json');
    const saved = await readFile(cfgFile, 'utf8');
    const cfg = JSON.parse(saved);
    cfg.images.hosts = [config.images.hosts[0], 'backup.example.org'];
    await writeFile(cfgFile, JSON.stringify(cfg));
    try {
      const out = join(tmp, 'dist-two-hosts');
      const r = astroBuild(out);
      assert.equal(r.status, 0, r.out);
      const html = await readFile(join(out, 'sample', 'vol01', 'c001', 'index.html'), 'utf8');
      assert.deepEqual(jsonAttr(html, 'data-hosts'), [config.images.hosts[0], 'backup.example.org']);
      assert.ok(html.includes('你好，世界！'), '上一个用例放回的分片应仍被取到，文字层完整');
      assert.ok(html.includes(`${imageOrigin}/${config.images.prefix}sample/vol01/c001/1-0123456789ab.webp`), '图片仍从第一条域名取');
      assert.ok(!html.includes('https://backup.example.org/'), '第二条域名只给切源脚本用，不该出现在图片 URL 里');
      // 真实切源与逐页重试由 reader-images 行为测试覆盖，这里守住页面接线与构建后的模块。
      assert.equal((html.match(/class="image-retry btn"/g) ?? []).length, 3, '每页提供独立重试入口');
      assert.match(await readerChunks(out, html), /image-feedback/, '图片状态模块必须进入阅读器产物');
      const search = await readFile(join(out, 'search', 'index.html'), 'utf8');
      const m = /<script type="application\/json" id="search-config">(.*?)<\/script>/.exec(search);
      assert.deepEqual(JSON.parse(m[1]).images.hosts, [config.images.hosts[0], 'backup.example.org']);
    } finally {
      await writeFile(cfgFile, saved);
    }
  });

  await t.test('features.text_layer 关：阅读器没有文字层，期页也不再标「有台词」', async () => {
    const cfgFile = join(GENERATED, 'site-config.json');
    const saved = await readFile(cfgFile, 'utf8');
    const cfg = JSON.parse(saved);
    cfg.features.text_layer = false;
    await writeFile(cfgFile, JSON.stringify(cfg));
    try {
      const out = join(tmp, 'dist-no-text-layer');
      const r = astroBuild(out);
      assert.equal(r.status, 0, r.out);
      const html = await readFile(join(out, 'sample', 'vol01', 'c001', 'index.html'), 'utf8');
      assert.ok(!html.includes('class="text-layer'), 'flag 关了不该有文字层');
      assert.ok(!html.includes('你好，世界！'), 'flag 关了台词不该进 HTML');
      assert.ok(html.includes('id="p1"') && html.includes('.webp'), '图片与翻页照常');
      const issue = await readFile(join(out, 'sample', 'vol01', 'index.html'), 'utf8');
      assert.ok(!issue.includes('有台词'), '阅读器没有文字层时，列表不该承诺「有台词」');
    } finally {
      await writeFile(cfgFile, saved);
    }
  });
});

test('0 话也能建：空 data/ 目录下首页、搜索页、书架、404、索引总表、sitemap 都在', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-site-empty-'));
  const DIST = join(tmp, 'dist');
  const env = { CONFIG_FILE: await configSnapshot(tmp), DATA_DIR: join(tmp, 'data'), DIST_DIR: DIST, OUT_DIR: join(tmp, 'out') };
  t.after(() => rm(tmp, { recursive: true, force: true }));
  for (const script of ['build-site.mjs', 'build-index.mjs', 'build-sitemap.mjs']) {
    const r = run(script, env);
    assert.equal(r.status, 0, `${script} 失败：\n${r.out}`);
  }
  for (const p of ['index.html', '404.html', 'search/index.html', 'library/index.html', 'index/series.json', 'sitemap.xml', 'robots.txt']) {
    assert.ok(existsSync(join(DIST, p)), `${p} 不存在`);
  }
  const home = await readFile(join(DIST, 'index.html'), 'utf8');
  assert.ok(home.includes('还没有作品'));
  assert.equal(/<h1[^>]*>(.*?)<\/h1>/.exec(home)?.[1], config.site.title);
  assert.deepEqual(JSON.parse(await readFile(join(DIST, 'index', 'series.json'), 'utf8')), []);
  const generated = JSON.parse(await readFile(join(GENERATED, 'gallery.json'), 'utf8'));
  assert.equal(generated.searchDb, null, '未建检索库不能沿用上次构建的版本');
  assert.ok(!existsSync(join(DIST, 'release.json')));
  const search = await readFile(join(DIST, 'search', 'index.html'), 'utf8');
  const searchConfig = JSON.parse(/<script type="application\/json" id="search-config">(.*?)<\/script>/.exec(search)[1]);
  assert.equal(searchConfig.db.release, null);
  assert.deepEqual(searchConfig.coverage, { chapters: 0, withText: 0, boxes: 0 });
  assert.ok(search.includes('当前还没有作品'));
  assert.ok(!search.includes('作品和漫画仍可正常浏览'));
  const library = await readFile(join(DIST, 'library', 'index.html'), 'utf8');
  const catalog = /<script\b(?=[^>]*\bid="library-catalog")(?=[^>]*\btype="application\/json")[^>]*>([\s\S]*?)<\/script>/.exec(library);
  assert.ok(catalog, '空库也要输出书架目录数据块');
  assert.deepEqual(JSON.parse(catalog[1]), []);
  for (const id of ['library-bookmarks', 'bookmark-count', 'bookmark-list', 'bookmark-empty', 'bookmark-storage-note', 'bookmark-filter']) {
    assert.ok(library.includes(`id="${id}"`), `空库书签区缺 #${id}`);
  }
  assert.ok(library.includes('<meta name="robots" content="noindex">'));
  assert.ok(!library.includes('rel="canonical"'));
  assert.match(library, /<noscript>[\s\S]*?书架[\s\S]*?<\/noscript>/);
  assert.equal(((await readFile(join(DIST, 'sitemap.xml'), 'utf8')).match(/<url>/g) ?? []).length, 2);
  assert.equal(run('check.mjs', env).status, 0);
});

test('作品 id 撞上站点固定路由时构建报错而不是静默丢页', { timeout: 60_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-site-reserved-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const configFile = await configSnapshot(tmp);
  for (const id of ['search', 'library']) {
    const data = join(tmp, id, 'data');
    await mkdir(join(data, 'meta'), { recursive: true });
    await writeFile(
      join(data, 'meta', `${id}.yaml`),
      `id: ${id}\ntitle: x\nissues:\n  - id: v1\n    number: 1\n    title: v\n    chapters:\n      - id: c1\n        number: 1\n        title: c\n        pages:\n          - { n: 1, img: 0123456789ab, w: 10, h: 10 }\n`,
    );
    const env = { CONFIG_FILE: configFile, DATA_DIR: data, DIST_DIR: join(tmp, id, 'dist'), OUT_DIR: join(tmp, id, 'out') };
    for (const script of ['build-site.mjs', 'build-index.mjs']) {
      const r = run(script, env);
      assert.notEqual(r.status, 0, `${script} 应该拒绝 ${id}`);
      assert.ok(r.out.includes(id), `错误信息应指出保留字 ${id}`);
      assert.match(r.out, /保留字/);
    }
  }
});
