// 站点构建的端到端测试：拿测试样本真跑 build:config → build:site（astro build）→ build:index →
// build:sitemap，再让 check 守卫过一遍产物。不 mock 任何一步——每话恰好一个 HTML、台词在 HTML 里、
// 索引与 sitemap 的形状，这些只有真构建出来才算数。
//
// DATA_DIR / DIST_DIR / OUT_DIR 全指到样本与临时目录，不碰仓库根的 data/ dist/ out/。
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

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const SITE_DIR = join(ROOT, 'packages', 'site');
/** 站点生成物目录：build:site 写、astro build 读；下面有几个用例会动它里面的文件再直接跑 astro。 */
const GENERATED = join(SITE_DIR, 'src', 'generated');

function run(script, env) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
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

test('站点构建：样本数据 → 每话一 HTML + 索引分片 + sitemap，守卫通过', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-site-'));
  const DIST = join(tmp, 'dist');
  const env = { DATA_DIR: FIXTURES, DIST_DIR: DIST, OUT_DIR: join(tmp, 'out') };
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // 预先放一份「上次构建留下、如今已从 data/ 撤掉的话」的分片：build:site 声称 text/ 先整个删掉再写，
  // 构建完它必须不在——否则撤掉的话还能被 glob 到。
  const staleShard = join(GENERATED, 'text', 'stale', 'v', 'c.json');
  await mkdir(dirname(staleShard), { recursive: true });
  await writeFile(staleShard, '{"chapter":"stale/v/c","pages":[]}\n');

  for (const script of ['build-config.mjs', 'build-site.mjs', 'build-index.mjs', 'build-sitemap.mjs']) {
    const r = run(script, env);
    assert.equal(r.status, 0, `${script} 失败：\n${r.out}`);
  }

  await t.test('每话恰好一个 HTML，且是该目录下唯一的 HTML', async () => {
    for (const key of ['sample/vol01/c001', 'sample/vol01/c002', 'sample/vol02/c003', 'zeta/v1/ch1']) {
      const dir = join(DIST, ...key.split('/'));
      assert.ok(existsSync(join(dir, 'index.html')), `${key}/index.html 不存在`);
      const htmls = (await walk(dir)).filter((f) => extname(f) === '.html');
      assert.equal(htmls.length, 1, `${key} 下的 HTML：${htmls.join(', ')}`);
    }
    // 作品页、期页、首页、搜索页、404
    for (const p of ['index.html', '404.html', 'search/index.html', 'sample/index.html', 'sample/vol01/index.html', 'zeta/v1/index.html']) {
      assert.ok(existsSync(join(DIST, p)), `${p} 不存在`);
    }
    // 没有图片、没有 DB。搜索页的执行器是懒加载 chunk（sqlite-wasm 的 wasm 与 worker 代理
    // 也只能是独立文件），放在 dist/_astro/ 下；但话目录里不许出现独立 JS/CSS——话页面
    // 仍是「一个 HTML，样式与脚本内联」，检索脚本不该被引到阅读器里。
    const files = await walk(DIST);
    const bad = files.filter((f) => ['.avif', '.webp', '.png', '.jpg', '.sqlite'].includes(extname(f)));
    assert.deepEqual(bad, []);
    for (const key of ['sample/vol01/c001', 'sample/vol01/c002', 'sample/vol02/c003', 'zeta/v1/ch1']) {
      const dir = join(DIST, ...key.split('/'));
      const stray = (await walk(dir)).filter((f) => ['.js', '.css', '.wasm'].includes(extname(f)));
      assert.deepEqual(stray, [], `${key} 下不该有独立 JS/CSS/wasm`);
      const html = await readFile(join(dir, 'index.html'), 'utf8');
      assert.ok(!html.includes('/_astro/'), `${key} 的 HTML 不该引用 _astro/ 下的检索 chunk`);
    }
  });

  await t.test('阅读器 HTML：台词、avif/webp URL、上下话链接、#p 脚本、文字层高亮 id', async () => {
    const html = await readFile(join(DIST, 'sample', 'vol01', 'c001', 'index.html'), 'utf8');
    // 台词是普通 DOM 文本
    assert.ok(html.includes('你好，世界！'), '台词文本不在 HTML 里');
    assert.ok(html.includes('漫画作者的契約'), '第二个框的台词不在 HTML 里');
    assert.ok(html.includes('id="p1b0"') && html.includes('id="p1b1"'), '框的 id 应是 p<n>b<i>');
    assert.ok(html.includes('id="p2b0"'), '点标签（w=h=0）也应有框');
    assert.match(html, /class="box dot[^"]*"[^>]*id="p2b0"/, 'w=h=0 的框应带 dot 类');
    // 三页的 <picture>：avif source + webp img，域名取 images.hosts[0]
    for (const [n, hash] of [[1, '0123456789ab'], [2, '123456789abc'], [3, '23456789abcd']]) {
      assert.ok(html.includes(`https://img.example.org/img/sample/vol01/c001/${n}-${hash}.avif`), `第 ${n} 页 avif URL`);
      assert.ok(html.includes(`https://img.example.org/img/sample/vol01/c001/${n}-${hash}.webp`), `第 ${n} 页 webp URL`);
      assert.ok(html.includes(`id="p${n}"`), `第 ${n} 页的锚点`);
    }
    assert.equal((html.match(/<source type="image\/avif"/g) ?? []).length, 3, '三页都在这一份 HTML 里');
    assert.match(html, /<source type="image\/avif" srcset="https:\/\/img\.example\.org\/[^"]+\.avif"/);
    assert.match(html, /<img src="https:\/\/img\.example\.org\/[^"]+\.webp" loading="lazy"[^>]*width="1200" height="1700"[^>]*alt="/);
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
    assert.deepEqual(jsonAttr(html, 'data-hosts'), ['img.example.org']);
    // 外壳
    assert.ok(html.includes('<html lang="zh-CN">'));
    assert.ok(html.includes('<link rel="canonical" href="https://gallery.example.org/sample/vol01/c001/">'));
    assert.match(html, /<meta property="og:title" content="第一话 开端 · 第一卷 · 示例作品 · 漫画画廊">/);

    // 跨期的上一话：c003（第二卷）的上一话是 c002（第一卷）
    const html3 = await readFile(join(DIST, 'sample', 'vol02', 'c003', 'index.html'), 'utf8');
    assert.ok(html3.includes('rel="prev" href="/sample/vol01/c002/"'));
    assert.ok(!html3.includes('rel="next"'));
  });

  await t.test('没有台词稿的话：页面正常、没有文字层', async () => {
    const html = await readFile(join(DIST, 'sample', 'vol02', 'c003', 'index.html'), 'utf8');
    assert.ok(html.includes('https://img.example.org/img/sample/vol02/c003/1-56789abcdef0.avif'));
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
    for (const id of ['search-form', 'search-input', 'search-results', 'search-status', 'search-config']) {
      assert.ok(search.includes(`id="${id}"`), `搜索页缺 #${id}`);
    }
    const m = /<script type="application\/json" id="search-config">(.*?)<\/script>/.exec(search);
    assert.ok(m, 'search-config JSON');
    const cfg = JSON.parse(m[1]);
    assert.deepEqual(cfg.images.hosts, ['img.example.org']);
    assert.equal(cfg.search.request_chunk_size, cfg.db.page_size);
    const notFound = await readFile(join(DIST, '404.html'), 'utf8');
    assert.ok(notFound.includes('<meta name="robots" content="noindex">'));
    assert.ok(!notFound.includes('rel="canonical"'));
  });

  await t.test('index/ 分片', async () => {
    const summary = JSON.parse(await readFile(join(DIST, 'index', 'series.json'), 'utf8'));
    assert.deepEqual(summary, [
      { id: 'zeta', title: '终章短篇', url: '/zeta/', issues: 1, chapters: 1 },
      { id: 'sample', title: '示例作品', url: '/sample/', issues: 2, chapters: 3 },
    ]);
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
    assert.ok(xml.includes('<loc>https://gallery.example.org/</loc>'));
    assert.ok(xml.includes('<loc>https://gallery.example.org/search/</loc>'));
    assert.ok(xml.includes('<loc>https://gallery.example.org/sample/</loc>'));
    assert.ok(xml.includes('<url><loc>https://gallery.example.org/sample/vol01/</loc><lastmod>2026-01-01</lastmod></url>'));
    assert.ok(xml.includes('<url><loc>https://gallery.example.org/sample/vol01/c001/</loc><lastmod>2026-01-01</lastmod></url>'));
    assert.ok(xml.includes('<url><loc>https://gallery.example.org/sample/vol02/c003/</loc><lastmod>2026-06-01</lastmod></url>'));
    assert.ok(xml.includes('<url><loc>https://gallery.example.org/zeta/v1/ch1/</loc></url>'), '没有 published 的期不出 lastmod');
    // 2 固定 + 2 作品 + 3 期 + 4 话
    assert.equal((xml.match(/<url>/g) ?? []).length, 11);
    const robots = await readFile(join(DIST, 'robots.txt'), 'utf8');
    assert.equal(robots, 'User-agent: *\nAllow: /\n\nSitemap: https://gallery.example.org/sitemap.xml\n');
  });

  await t.test('站点生成物：gallery.json 不含台词，text/ 按话分片，过期分片被清掉', async () => {
    const gen = GENERATED;
    const gallery = JSON.parse(await readFile(join(gen, 'gallery.json'), 'utf8'));
    assert.deepEqual(gallery.totals, { series: 2, issues: 3, chapters: 4, pages: 8, boxes: 5 });
    const pagesInGallery = gallery.series.flatMap((s) => s.issues.flatMap((i) => i.chapters.flatMap((c) => c.pages)));
    assert.equal(pagesInGallery.length, 8);
    assert.ok(pagesInGallery.every((pg) => !('boxes' in pg) && pg.keys.avif && pg.keys.webp), 'gallery.json 的页只有结构与图片 key，不含 boxes');
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

  // 下面两个用例改动 src/generated/ 里的文件再直接跑 astro build，跑完原样放回：
  // 这个目录是共享的构建中间态，不能留下与 gallery.json 对不上的东西。

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
    cfg.images.hosts = ['img.example.org', 'img2.example.org'];
    await writeFile(cfgFile, JSON.stringify(cfg));
    try {
      const out = join(tmp, 'dist-two-hosts');
      const r = astroBuild(out);
      assert.equal(r.status, 0, r.out);
      const html = await readFile(join(out, 'sample', 'vol01', 'c001', 'index.html'), 'utf8');
      assert.deepEqual(jsonAttr(html, 'data-hosts'), ['img.example.org', 'img2.example.org']);
      assert.ok(html.includes('你好，世界！'), '上一个用例放回的分片应仍被取到，文字层完整');
      assert.ok(html.includes('https://img.example.org/img/sample/vol01/c001/1-0123456789ab.webp'), '图片仍从第一条域名取');
      assert.ok(!html.includes('https://img2.example.org/'), '第二条域名只给切源脚本用，不该出现在图片 URL 里');
      // 内联脚本里的替换规则与 lib/gallery.js 的 swapHost 是同一条（那边有单测）：这里只钉它没被改成别的形状
      assert.ok(html.includes("u.replace('//'+hosts[0]+'/','//'+hosts[1]+'/')") || html.includes("u.replace('//' + hosts[0] + '/', '//' + hosts[1] + '/')"), '切源脚本的替换规则');
      const search = await readFile(join(out, 'search', 'index.html'), 'utf8');
      const m = /<script type="application\/json" id="search-config">(.*?)<\/script>/.exec(search);
      assert.deepEqual(JSON.parse(m[1]).images.hosts, ['img.example.org', 'img2.example.org']);
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
      assert.ok(html.includes('id="p1"') && html.includes('.avif'), '图片与翻页照常');
      const issue = await readFile(join(out, 'sample', 'vol01', 'index.html'), 'utf8');
      assert.ok(!issue.includes('有台词'), '阅读器没有文字层时，列表不该承诺「有台词」');
    } finally {
      await writeFile(cfgFile, saved);
    }
  });
});

test('0 话也能建：空 data/ 目录下首页、搜索页、404、索引总表、sitemap 都在', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-site-empty-'));
  const DIST = join(tmp, 'dist');
  const env = { DATA_DIR: join(tmp, 'data'), DIST_DIR: DIST, OUT_DIR: join(tmp, 'out') };
  t.after(() => rm(tmp, { recursive: true, force: true }));
  for (const script of ['build-site.mjs', 'build-index.mjs', 'build-sitemap.mjs']) {
    const r = run(script, env);
    assert.equal(r.status, 0, `${script} 失败：\n${r.out}`);
  }
  for (const p of ['index.html', '404.html', 'search/index.html', 'index/series.json', 'sitemap.xml', 'robots.txt']) {
    assert.ok(existsSync(join(DIST, p)), `${p} 不存在`);
  }
  assert.ok((await readFile(join(DIST, 'index.html'), 'utf8')).includes('还没有作品'));
  assert.deepEqual(JSON.parse(await readFile(join(DIST, 'index', 'series.json'), 'utf8')), []);
  assert.equal(((await readFile(join(DIST, 'sitemap.xml'), 'utf8')).match(/<url>/g) ?? []).length, 2);
  assert.equal(run('check.mjs', env).status, 0);
});

test('作品 id 撞上站点固定路由（search）时构建报错而不是静默丢页', { timeout: 60_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-site-reserved-'));
  const data = join(tmp, 'data');
  await mkdir(join(data, 'meta'), { recursive: true });
  await writeFile(
    join(data, 'meta', 'search.yaml'),
    'id: search\ntitle: x\nissues:\n  - id: v1\n    number: 1\n    title: v\n    chapters:\n      - id: c1\n        number: 1\n        title: c\n        pages:\n          - { n: 1, img: 0123456789ab, w: 10, h: 10 }\n',
  );
  const env = { DATA_DIR: data, DIST_DIR: join(tmp, 'dist'), OUT_DIR: join(tmp, 'out') };
  t.after(() => rm(tmp, { recursive: true, force: true }));
  for (const script of ['build-site.mjs', 'build-index.mjs']) {
    const r = run(script, env);
    assert.notEqual(r.status, 0, `${script} 应该失败`);
    assert.match(r.out, /search/);
    assert.match(r.out, /保留字/);
  }
});
