// build:sitemap 与 sitemap 守卫的测试：URL 清单的两条入口一致、分片与 index 的形状、XML 转义、
// IndexNow key 文件、真 spawn build-sitemap.mjs 到临时 dist、真 spawn check.mjs 看它抓不抓得住漏掉的话。
//
// DATA_DIR 指到样本、DIST_DIR / OUT_DIR 指到临时目录，不碰仓库根的 data/ dist/ out/。
// check 会 lint 整个仓库，别处的半成品能让它整体红：对 check 的断言以「dist」那一节的输出为准，
// 退出码只在其余节都绿时才有意义（见 failedSections）。
// 域名从仓库的 site.config.yaml 读（脚本经 loadSiteConfig 读的是固定路径，指不到临时配置），
// key 的写入因此经纯函数 / helper 验；脚本路径按配置当前有没有设 key 分别断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../lib/config.mjs';
import { loadGallery } from '../lib/data.mjs';
import { buildManifest } from '../lib/manifest.mjs';
import {
  siteUrls,
  renderSitemaps,
  renderRobots,
  parseSitemap,
  indexNowKeyFile,
  writeIndexNowKeyFile,
  shardName,
  SITEMAP_FILE,
  SITEMAP_MAX_PER_FILE,
  SITEMAP_PROTOCOL_MAX_URLS,
} from '../lib/sitemap.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const CONFIG = await loadSiteConfig();
const ORIGIN = `https://${CONFIG.site.domain}`;
const GALLERY = await loadGallery({ dataDir: FIXTURES, imagePrefix: CONFIG.images.prefix });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 样本的全部 URL：2 固定 + 2 作品 + 3 期 + 4 话，作品按 sort（zeta 在前），话的 lastmod 随所属期。 */
const EXPECTED = [
  { loc: `${ORIGIN}/` },
  { loc: `${ORIGIN}/search/` },
  { loc: `${ORIGIN}/zeta/` },
  { loc: `${ORIGIN}/zeta/v1/` },
  { loc: `${ORIGIN}/zeta/v1/ch1/` },
  { loc: `${ORIGIN}/sample/` },
  { loc: `${ORIGIN}/sample/vol01/`, lastmod: '2026-01-01' },
  { loc: `${ORIGIN}/sample/vol01/c001/`, lastmod: '2026-01-01' },
  { loc: `${ORIGIN}/sample/vol01/c002/`, lastmod: '2026-01-01' },
  { loc: `${ORIGIN}/sample/vol02/`, lastmod: '2026-06-01' },
  { loc: `${ORIGIN}/sample/vol02/c003/`, lastmod: '2026-06-01' },
];

/** 干净的环境：去掉本机 / CI 里可能存在的目录与版本变量，脚本的行为只由测试给的决定。 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(RELEASE_|DATA_DIR$|DIST_DIR$|OUT_DIR$)/.test(k)) delete env[k];
  return env;
}

/** 异步 spawn（与仓库里其他测试同一套写法）：不用 spawnSync，免得将来加进程内服务器时把事件循环卡死。 */
function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      env: { ...cleanEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** 把 check 的输出按「── 标题 ──」切成节：标题 → 该节的文本。 */
function sections(out) {
  const map = new Map();
  for (const chunk of out.split('\n── ').slice(1)) {
    const i = chunk.indexOf(' ──\n');
    map.set(chunk.slice(0, i), chunk.slice(i + 4));
  }
  return map;
}
function distSection(out) {
  for (const [title, body] of sections(out)) if (title.startsWith('dist：')) return body;
  assert.fail(`check 输出里没有 dist 那一节：\n${out}`);
}
/** 失败的节名（末尾那行「✘ check：N 节未通过」不算）。 */
function failedSections(out) {
  return [...sections(out)].filter(([, body]) => /^✘ (?!check：)/m.test(body)).map(([title]) => title.split('：')[0]);
}

/** 只放 check「每话恰好一个 HTML」需要的东西：每话一个 index.html。不跑 astro——这里测的是 sitemap 守卫。 */
async function fakeDist(dir) {
  for (const c of GALLERY.chapters) {
    const f = join(dir, c.seriesId, c.issueId, c.id, 'index.html');
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, '<!doctype html>');
  }
}

test('siteUrls：模型与 manifest.json 两条入口产出完全一致；话的 lastmod 随所属期，没有 published 就不写', () => {
  const fromModel = siteUrls(GALLERY, ORIGIN);
  assert.deepEqual(fromModel, EXPECTED);
  assert.ok(fromModel.slice(0, 6).every((e) => !('lastmod' in e)), '没有日期的条目不带 lastmod 这个 key');

  // 与 out/manifest.json 同形：经 JSON 往返，没有 published 的期是 null 而不是 undefined
  const manifest = JSON.parse(JSON.stringify(buildManifest(GALLERY, CONFIG, { version: 'test', generatedAt: '2026-09-03T00:00:00.000Z' })));
  assert.equal(manifest.series[0].issues[0].published, null, '样本里 zeta 的期没有 published');
  assert.deepEqual(siteUrls(manifest, ORIGIN), fromModel);

  // origin 末尾多余的 / 容忍；缺协议或带路径拒绝——<loc> 少了协议搜索引擎会整条静默丢掉
  assert.deepEqual(siteUrls(GALLERY, `${ORIGIN}/`), fromModel);
  assert.throws(() => siteUrls(GALLERY, CONFIG.site.domain), /origin/);
  assert.throws(() => siteUrls(GALLERY, `${ORIGIN}/sub`), /origin/);
});

test('renderSitemaps：不超过 maxPerFile 时只有 sitemap.xml，形状固定，XML 转义，parseSitemap 能读回', () => {
  const entries = [...EXPECTED.slice(0, 3), { loc: `${ORIGIN}/q/?a=1&b=<2>&c="x"`, lastmod: '2026-02-02' }];
  const files = renderSitemaps(entries, { origin: ORIGIN });
  assert.deepEqual(files.map((f) => f.name), [SITEMAP_FILE]);
  const xml = files[0].xml;
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'));
  assert.ok(xml.endsWith('</urlset>\n'));
  assert.ok(xml.includes(`  <url><loc>${ORIGIN}/</loc></url>\n`));
  assert.ok(xml.includes(`<url><loc>${ORIGIN}/q/?a=1&amp;b=&lt;2&gt;&amp;c=&quot;x&quot;</loc><lastmod>2026-02-02</lastmod></url>`));
  assert.equal((xml.match(/&(?!amp;|lt;|gt;|quot;|apos;)/g) ?? []).length, 0, '没有裸 &');
  assert.deepEqual(parseSitemap(xml), { index: false, locs: entries.map((e) => e.loc) }, '读回时实体还原');
  // 正好等于 maxPerFile 也不拆；空清单也是合法的 urlset
  assert.equal(renderSitemaps(EXPECTED, { origin: ORIGIN, maxPerFile: EXPECTED.length }).length, 1);
  assert.deepEqual(parseSitemap(renderSitemaps([], { origin: ORIGIN })[0].xml), { index: false, locs: [] });
});

test('renderSitemaps：100 001 条、45 000 一片 → index + 3 片，片内条数与 index 指向正确', () => {
  const entries = Array.from({ length: 100001 }, (_, i) => ({ loc: `${ORIGIN}/p/${i}/` }));
  const files = renderSitemaps(entries, { origin: ORIGIN, maxPerFile: 45000, today: '2026-09-03' });
  assert.deepEqual(files.map((f) => f.name), ['sitemap.xml', 'sitemap-1.xml', 'sitemap-2.xml', 'sitemap-3.xml']);

  const index = parseSitemap(files[0].xml);
  assert.equal(index.index, true);
  assert.deepEqual(index.locs, [1, 2, 3].map((n) => `${ORIGIN}/${shardName(n)}`));
  assert.ok(files[0].xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'));
  assert.ok(files[0].xml.endsWith('</sitemapindex>\n'));
  assert.equal((files[0].xml.match(/<lastmod>2026-09-03<\/lastmod>/g) ?? []).length, 3, 'index 里每个 <sitemap> 带传入的当天日期');
  assert.ok(!files[0].xml.includes('<url>'), 'index 里只有 <sitemap>，没有 <url>');

  const shards = files.slice(1).map((f) => parseSitemap(f.xml));
  assert.ok(shards.every((s) => !s.index));
  assert.deepEqual(shards.map((s) => s.locs.length), [45000, 45000, 10001]);
  assert.equal(shards[1].locs[0], `${ORIGIN}/p/45000/`);
  assert.equal(shards[2].locs.at(-1), `${ORIGIN}/p/100000/`);
  assert.deepEqual(shards.flatMap((s) => s.locs), entries.map((e) => e.loc), '拼回去就是原清单，一条不丢不重');

  assert.equal(SITEMAP_MAX_PER_FILE, 45000, '默认拆分线');
  assert.ok(SITEMAP_MAX_PER_FILE < SITEMAP_PROTOCOL_MAX_URLS && SITEMAP_PROTOCOL_MAX_URLS === 50000);
});

test('renderSitemaps / parseSitemap：参数守卫——maxPerFile 超协议上限、拆分时没给 today、origin 不合法、不是 sitemap', () => {
  assert.throws(() => renderSitemaps(EXPECTED, { origin: ORIGIN, maxPerFile: 50001 }), /50 000/);
  assert.throws(() => renderSitemaps(EXPECTED, { origin: ORIGIN, maxPerFile: 0 }), /maxPerFile/);
  assert.throws(() => renderSitemaps(EXPECTED, { origin: ORIGIN, maxPerFile: 3 }), /today/);
  assert.throws(() => renderSitemaps(EXPECTED, { origin: ORIGIN, maxPerFile: 3, today: '2026/09/03' }), /today/);
  assert.throws(() => renderSitemaps(EXPECTED, { origin: CONFIG.site.domain }), /origin/);
  assert.throws(() => parseSitemap('<html></html>'), /不是 sitemap/);
});

test('renderRobots：全站放行，Sitemap 永远指 sitemap.xml', () => {
  assert.equal(renderRobots(ORIGIN), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  assert.equal(renderRobots(`${ORIGIN}/`), renderRobots(ORIGIN));
});

test('IndexNow key 文件：空 key 不写；有 key 写 <key>.txt、内容即 key、末尾无换行；非法 key 拒绝', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-indexnow-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  assert.equal(indexNowKeyFile({ seo: { indexnow_key: '' } }), null);
  assert.equal(indexNowKeyFile({}), null, '没有 seo 段按未启用');
  assert.equal(await writeIndexNowKeyFile({ seo: { indexnow_key: '' } }, join(tmp, 'a')), null);
  assert.ok(!existsSync(join(tmp, 'a')), '没启用时连目录都不建');

  const key = 'a1B2c3D4-e5f6';
  assert.deepEqual(indexNowKeyFile({ seo: { indexnow_key: key } }), { name: `${key}.txt`, content: key });
  const path = await writeIndexNowKeyFile({ seo: { indexnow_key: key } }, join(tmp, 'dist'));
  assert.equal(path, join(tmp, 'dist', `${key}.txt`));
  const bytes = await readFile(path);
  assert.equal(bytes.toString('utf8'), key);
  assert.equal(bytes.length, key.length, '末尾没有换行——协议按字节比对');

  for (const bad of ['short', '../../etc/passwd', 'has space here', 'x'.repeat(129), 'ключ-ключ-ключ']) {
    assert.throws(() => indexNowKeyFile({ seo: { indexnow_key: bad } }), /indexnow_key/, bad);
  }
});

test('build-sitemap.mjs：样本 → sitemap.xml + robots.txt，过期分片被清掉，打印文件数与 URL 数', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-sitemap-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const DIST = join(tmp, 'dist');
  await mkdir(DIST, { recursive: true });
  await writeFile(join(DIST, 'sitemap-7.xml'), '<urlset/>');

  const r = await run('build-sitemap.mjs', { DATA_DIR: FIXTURES, DIST_DIR: DIST, OUT_DIR: join(tmp, 'out') });
  assert.equal(r.status, 0, r.out);
  assert.equal(await readFile(join(DIST, SITEMAP_FILE), 'utf8'), renderSitemaps(EXPECTED, { origin: ORIGIN })[0].xml, '脚本写的就是纯函数的产出');
  assert.equal(await readFile(join(DIST, 'robots.txt'), 'utf8'), renderRobots(ORIGIN));
  assert.ok(!existsSync(join(DIST, 'sitemap-7.xml')), '上次留下的分片应被清掉');
  assert.match(r.out, /删掉过期分片 sitemap-7\.xml/);

  const key = CONFIG.seo.indexnow_key;
  if (key) {
    assert.match(r.out, new RegExp(`写了 3 个文件、${EXPECTED.length} 条 URL；IndexNow key 文件已写`));
    assert.equal(await readFile(join(DIST, `${key}.txt`), 'utf8'), key);
  } else {
    assert.match(r.out, new RegExp(`写了 2 个文件、${EXPECTED.length} 条 URL；IndexNow key 文件未写`));
    assert.match(r.out, /seo\.indexnow_key 为空/);
  }
});

test('check 守卫：sitemap 缺一话 → dist 节点名那一话；build:sitemap 补全后通过；index 形态跟进各分片；缺分片、超上限被抓', { timeout: 180_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-sitemap-check-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const DIST = join(tmp, 'dist');
  const env = { DATA_DIR: FIXTURES, DIST_DIR: DIST, OUT_DIR: join(tmp, 'out') };
  await fakeDist(DIST);
  const missingKey = 'sample/vol02/c003';
  const missingUrl = `${ORIGIN}/${missingKey}/`;

  // 1. 缺一话
  await writeFile(join(DIST, SITEMAP_FILE), renderSitemaps(EXPECTED.filter((e) => e.loc !== missingUrl), { origin: ORIGIN })[0].xml);
  const r1 = await run('check.mjs', env);
  assert.equal(r1.status, 1, r1.out);
  const d1 = distSection(r1.out);
  assert.match(d1, new RegExp(`^✘ sitemap 缺 ${escapeRe(missingKey)}（${escapeRe(missingUrl)}）$`, 'm'));
  assert.ok(!d1.includes('sitemap 缺 sample/vol01/'), '在的话不该被点名');
  assert.ok(!d1.includes('sitemap 缺 zeta/'), '在的话不该被点名');
  assert.deepEqual(failedSections(r1.out).filter((s) => s !== 'lint'), ['dist'], `除 dist（与可能的 lint）外不该有别的节失败：\n${r1.out}`);

  // 2. 用 build:sitemap 真生成补全 → dist 节通过
  const b = await run('build-sitemap.mjs', env);
  assert.equal(b.status, 0, b.out);
  const r2 = await run('check.mjs', env);
  const d2 = distSection(r2.out);
  assert.match(d2, /^✔ 通过$/m, d2);
  assert.match(d2, new RegExp(`sitemap：1 个文件、${EXPECTED.length} 条 URL\n`));
  assert.deepEqual(failedSections(r2.out).filter((s) => s !== 'lint'), [], `除 lint 外不该有节失败：\n${r2.out}`);
  // 退出码只在 lint 也绿时才归本测试管——别处的半成品让 lint 红不是 sitemap 的错
  if (!failedSections(r2.out).length) assert.equal(r2.status, 0, r2.out);

  // 3. index 形态：3 条一片 → index + 4 片，守卫要跟进每一片
  const files = renderSitemaps(EXPECTED, { origin: ORIGIN, maxPerFile: 3, today: '2026-09-03' });
  assert.equal(files.length, 5);
  for (const f of files) await writeFile(join(DIST, f.name), f.xml);
  const r3 = await run('check.mjs', env);
  const d3 = distSection(r3.out);
  assert.match(d3, /^✔ 通过$/m, d3);
  assert.match(d3, new RegExp(`sitemap：4 个文件、${EXPECTED.length} 条 URL（index 形态）\n`));

  // 4. index 指向的最后一片没了（它装着 vol02 与 c003）：点名分片，也点名那一话
  await rm(join(DIST, shardName(4)));
  const r4 = await run('check.mjs', env);
  assert.equal(r4.status, 1, r4.out);
  const d4 = distSection(r4.out);
  assert.match(d4, new RegExp(`^✘ .*指向的分片 ${escapeRe(`${ORIGIN}/${shardName(4)}`)} 在 dist 里不存在`, 'm'));
  assert.match(d4, new RegExp(`^✘ sitemap 缺 ${escapeRe(missingKey)}`, 'm'));
  assert.ok(!d4.includes('sitemap 缺 sample/vol01/'), '其余分片里的话不受影响');

  // 5. 单文件超过协议上限 50 000 条（覆盖是全的，只是塞得太满）
  const filler = Array.from({ length: SITEMAP_PROTOCOL_MAX_URLS + 1 - EXPECTED.length }, (_, i) => `  <url><loc>${ORIGIN}/f/${i}/</loc></url>`);
  const huge = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...EXPECTED.map((e) => `  <url><loc>${e.loc}</loc></url>`),
    ...filler,
    '</urlset>',
    '',
  ].join('\n');
  await writeFile(join(DIST, SITEMAP_FILE), huge);
  const r5 = await run('check.mjs', env);
  assert.equal(r5.status, 1, r5.out);
  const d5 = distSection(r5.out);
  assert.match(d5, new RegExp(`^✘ .*sitemap\\.xml 有 ${SITEMAP_PROTOCOL_MAX_URLS + 1} 条 URL，超过协议上限 ${SITEMAP_PROTOCOL_MAX_URLS}`, 'm'));
  assert.ok(!d5.includes('sitemap 缺'), '覆盖是全的，不该点名任何一话');
});
