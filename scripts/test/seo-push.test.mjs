// push:search 的纯函数单测 + 脚本端到端。
//
// 纯函数（scripts/lib/seo-push.mjs）：页面集合、差集、分批、IndexNow 请求形状、状态码解读，直接比对。
// 脚本那部分在本进程里起两台假服务器——假 IndexNow、假站点（提供 /<key>.txt）——用环境变量把脚本
// 指过去，真 spawn 脚本、真发 HTTP：验的是「推的恰好是新增的那几话、请求体形状对、key 文件不对就
// 一条都不推、dry-run 零请求、key 文件核对会重试」。不连任何搜索引擎，不碰仓库根的 out/。
//
// manifest 用 scripts/lib/manifest.mjs 的 buildManifest 从 core 的测试样本生成（两个作品、三期、四话），
// 「上一版」是同一份去掉两话——差集就该恰好是那两话。域名从仓库的 site.config.yaml 读：推送的 URL
// 永远用真域名，SITE_ORIGIN 只改 key 文件去哪里取。
//
// SEO 只走 IndexNow；百度链路已废弃（要站点 token、长期不推会降权），不再有百度相关用例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../lib/config.mjs';
import { loadGallery } from '../lib/data.mjs';
import { buildManifest } from '../lib/manifest.mjs';
import {
  MANIFEST_PREVIOUS_FILE,
  INDEXNOW_BATCH_MAX,
  pageUrls,
  newUrls,
  chunk,
  indexNowRequest,
  interpretIndexNow,
} from '../lib/seo-push.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const SCRIPT = join(ROOT, 'scripts', 'seo-push.mjs');
const CONFIG = await loadSiteConfig();
const DOMAIN = CONFIG.site.domain;
const ORIGIN = `https://${DOMAIN}`;
const KEY = 'a1b2c3d4e5f6a7b8c9d0';

const gallery = await loadGallery({ dataDir: FIXTURES, imagePrefix: CONFIG.images.prefix });
const CURRENT = buildManifest(gallery, CONFIG, { version: '2026-09-03.2', generatedAt: '2026-09-03T04:00:00.000Z' });
/** 样本的全部页面：首页、/search/、作品（zeta 的 sort 更小排前）、期、话，与 sitemap 同序。 */
const ALL_PATHS = ['/', '/search/', '/zeta/', '/zeta/v1/', '/zeta/v1/ch1/', '/sample/', '/sample/vol01/', '/sample/vol01/c001/', '/sample/vol01/c002/', '/sample/vol02/', '/sample/vol02/c003/'];
const ALL_URLS = ALL_PATHS.map((p) => ORIGIN + p);
const NEW_PATHS = ['/sample/vol01/c002/', '/sample/vol02/c003/'];
const NEW_URLS = NEW_PATHS.map((p) => ORIGIN + p);

/** 上一版：同一份 manifest 去掉两话（期都还在，所以新增的只有话页）。 */
function previousManifest() {
  const m = structuredClone(CURRENT);
  m.version = '2026-09-03.1';
  for (const s of m.series) for (const iss of s.issues) iss.chapters = iss.chapters.filter((c) => !NEW_PATHS.includes(c.url));
  return m;
}

// ── 纯函数 ──────────────────────────────────────────────────────────

test('pageUrls：首页、/search/、每个作品 / 期 / 话，与 sitemap 同一批同一序；origin 末尾的 / 不重复', () => {
  assert.deepEqual(pageUrls(CURRENT, ORIGIN), ALL_URLS);
  assert.deepEqual(pageUrls(CURRENT, ORIGIN + '/'), ALL_URLS);
  assert.deepEqual(pageUrls({ series: [] }, ORIGIN), [`${ORIGIN}/`, `${ORIGIN}/search/`]);
  assert.deepEqual(pageUrls(previousManifest(), ORIGIN), ALL_URLS.filter((u) => !NEW_URLS.includes(u)));
});

test('newUrls：previous 为 null 全部算新（且是副本）；否则取差集、保持 current 顺序', () => {
  const all = newUrls(ALL_URLS, null);
  assert.deepEqual(all, ALL_URLS);
  assert.notEqual(all, ALL_URLS);
  assert.deepEqual(newUrls(ALL_URLS, pageUrls(previousManifest(), ORIGIN)), NEW_URLS);
  assert.deepEqual(newUrls(ALL_URLS, ALL_URLS), []);
  assert.deepEqual(newUrls(ALL_URLS, [...ALL_URLS].reverse()), [], '与 previous 的顺序无关');
  assert.deepEqual(newUrls(['b', 'a'], ['x']), ['b', 'a'], 'previous 里多出来的（下线的页）不算');
});

test('chunk：按 n 切、末批可不满、空列表零批、n 不合法就抛', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2], 2), [[1, 2]]);
  assert.deepEqual(chunk([], 3), []);
  assert.throws(() => chunk([1], 0), /正整数/);
  assert.throws(() => chunk([1], 1.5), /正整数/);
});

test('indexNowRequest：POST JSON { host, key, keyLocation, urlList }，每批 ≤ 10 000', () => {
  const keyLocation = `${ORIGIN}/${KEY}.txt`;
  const { url, init } = indexNowRequest({ endpoint: 'https://example.invalid/indexnow', host: DOMAIN, key: KEY, keyLocation, urls: NEW_URLS });
  assert.equal(url, 'https://example.invalid/indexnow');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(init.body), { host: DOMAIN, key: KEY, keyLocation, urlList: NEW_URLS });
  assert.equal(INDEXNOW_BATCH_MAX, 10_000);
  const tooMany = Array.from({ length: INDEXNOW_BATCH_MAX + 1 }, (_, i) => `${ORIGIN}/${i}/`);
  assert.throws(() => indexNowRequest({ endpoint: 'x', host: DOMAIN, key: KEY, keyLocation, urls: tooMany }), /最多 10000 条/);
  assert.ok(indexNowRequest({ endpoint: 'x', host: DOMAIN, key: KEY, keyLocation, urls: tooMany.slice(1) }));
});

test('interpretIndexNow：200 / 202 接受；400 / 403 / 422 / 429 各有中文说明；其它按状态码报失败', () => {
  assert.equal(interpretIndexNow(200).ok, true);
  assert.equal(interpretIndexNow(202).ok, true);
  assert.match(interpretIndexNow(202).message, /key 尚待引擎核对/);
  for (const [status, re] of [
    [400, /无效请求/],
    [403, /key 校验失败/],
    [422, /URL 不属于该 host/],
    [429, /太频繁/],
    [500, /失败（HTTP 500）/],
  ]) {
    const v = interpretIndexNow(status);
    assert.equal(v.ok, false, String(status));
    assert.match(v.message, re);
    assert.deepEqual(v.warnings, []);
  }
});

// ── 脚本端到端 ──────────────────────────────────────────────────────

/** 干净的环境：去掉本机 / CI 里可能存在的开关、凭据与产物目录，行为只由测试给的决定。 */
function cleanEnv() {
  const env = { ...process.env };
  const drop = /^(INDEXNOW_|SEO_PUSH_|SITE_ORIGIN$|GITHUB_STEP_SUMMARY$|DATA_DIR$|DIST_DIR$|OUT_DIR$|RELEASE_)/;
  for (const k of Object.keys(env)) if (drop.test(k)) delete env[k];
  return env;
}

/**
 * 异步 spawn 而不是 spawnSync：两台假服务器都住在这个测试进程里，spawnSync 会把事件循环卡住，
 * 服务器答不了话、子进程等回应——死锁。
 */
function run(env, args = []) {
  return new Promise((resolve) => {
    // key 文件核对默认会隔 20 秒重试几次（给 CDN 铺开留时间）；测试里只试一次、不等，要测重试的用例自己覆盖
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...cleanEnv(), SEO_PUSH_KEY_RETRIES: '1', SEO_PUSH_KEY_RETRY_MS: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** 临时 out/：manifest.json 必有，manifest-previous.json 按需。 */
async function workspace(t, { previous = previousManifest() } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-seo-push-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OUT = join(tmp, 'out');
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(CURRENT, null, 2) + '\n');
  if (previous) await writeFile(join(OUT, MANIFEST_PREVIOUS_FILE), JSON.stringify(previous, null, 2) + '\n');
  return { tmp, OUT, env: { OUT_DIR: OUT } };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

/** 一个刚被释放、肯定没人听的端口：连它得到的是真 ECONNREFUSED（端口 1 之类会被 fetch 判成「bad port」，不算）。 */
async function closedOrigin() {
  const server = createServer();
  const origin = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return origin;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * 两台假服务器：
 *   · IndexNow：记下每个请求（路径、头、正文），回 state.indexNowStatus；
 *   · 站点：只提供 /<key>.txt，内容 = state.keyBody（null → 404），记下每次访问。
 */
async function fakeEngines() {
  // keyDelayVisits：前几次访问 key 文件先回 404（模拟部署刚结束 CDN 还没铺开），之后才给内容
  const state = { indexNow: [], site: [], indexNowStatus: 200, keyBody: KEY, keyDelayVisits: 0 };
  const indexNow = createServer(async (req, res) => {
    state.indexNow.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body: await readBody(req) });
    res.writeHead(state.indexNowStatus);
    res.end();
  });
  const site = createServer((req, res) => {
    state.site.push(`${req.method} ${req.url}`);
    const keyVisits = state.site.filter((v) => v === `GET /${KEY}.txt`).length;
    if (req.method === 'GET' && req.url === `/${KEY}.txt` && state.keyBody != null && keyVisits > state.keyDelayVisits) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(state.keyBody);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const [indexNowOrigin, siteOrigin] = await Promise.all([listen(indexNow), listen(site)]);
  state.env = { INDEXNOW_ENDPOINT: `${indexNowOrigin}/indexnow`, SITE_ORIGIN: siteOrigin };
  state.reset = () => {
    state.indexNow.length = 0;
    state.site.length = 0;
    state.indexNowStatus = 200;
    state.keyBody = KEY;
    state.keyDelayVisits = 0;
  };
  state.close = () => Promise.all([indexNow, site].map((s) => new Promise((resolve) => s.close(resolve))));
  return state;
}

/** IndexNow 配上：走环境变量的 key（仓库配置里是空串）。 */
const ENABLED = { INDEXNOW_KEY: KEY };

test('push:search：只推新增的两话；IndexNow 正文形状；先核对 key 文件；摘要表', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const engines = await fakeEngines();
  t.after(engines.close);
  const summary = join(ws.tmp, 'summary.md');
  await writeFile(summary, '已有内容\n');
  const r = await run({ ...ws.env, ...engines.env, ...ENABLED, GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /共 11 条 URL，新增 2 条/);
  assert.match(r.out, /线上旧 manifest 版本 2026-09-03\.1，本版 2026-09-03\.2/);

  assert.deepEqual(engines.site, [`GET /${KEY}.txt`], '推之前取过 key 文件，且只取一次');
  assert.match(r.out, /key 文件核对通过/);

  assert.equal(engines.indexNow.length, 1, '两条 URL 一批');
  const inReq = engines.indexNow[0];
  assert.equal(inReq.method, 'POST');
  assert.equal(inReq.url, '/indexnow');
  assert.equal(inReq.contentType, 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(inReq.body), { host: DOMAIN, key: KEY, keyLocation: `${ORIGIN}/${KEY}.txt`, urlList: NEW_URLS });

  assert.match(r.out, /IndexNow（2 条）：已接受（200）/);
  assert.match(r.out, /Google：没有普通页面的推送接口/);
  assert.match(r.out, /push:search 完成：IndexNow 推 2 条/);

  const md = await readFile(summary, 'utf8');
  assert.ok(md.startsWith('已有内容\n'), '追加，不覆盖');
  assert.match(md, /### push:search（版本 2026-09-03\.2）/);
  assert.match(md, /\| IndexNow \| 2 \| 1 \| ✔ 已接受（200） \|/);
  assert.match(md, /\| Google \| — \| — \| ✔ 没有普通页面的推送接口/);
});

test('push:search：--all 推全部；没有 manifest-previous.json 也推全部并提示首次', { timeout: 30_000 }, async (t) => {
  const engines = await fakeEngines();
  t.after(engines.close);
  const ws = await workspace(t);
  const all = await run({ ...ws.env, ...engines.env, ...ENABLED }, ['--all']);
  assert.equal(all.status, 0, all.out);
  assert.match(all.out, /--all：推全部 11 条 URL/);
  assert.deepEqual(JSON.parse(engines.indexNow[0].body).urlList, ALL_URLS);

  engines.reset();
  const first = await workspace(t, { previous: null });
  const r = await run({ ...first.env, ...engines.env, ...ENABLED });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /manifest-previous\.json 不存在：线上没有旧 manifest（首次发布），推全部 11 条 URL/);
  assert.deepEqual(JSON.parse(engines.indexNow[0].body).urlList, ALL_URLS);
});

test('push:search：key 文件内容不对或取不到 → 退 1、零推送；SEO_PUSH_SKIP_KEY_CHECK=1 跳过核对', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const engines = await fakeEngines();
  t.after(engines.close);

  engines.keyBody = 'some-other-key';
  const wrong = await run({ ...ws.env, ...engines.env, ...ENABLED });
  assert.equal(wrong.status, 1, wrong.out);
  assert.match(wrong.out, /key 文件不在线上：.*回 HTTP 200，内容 "some-other-key"/);
  assert.match(wrong.out, /站点还没部署或 CDN 还是旧站，一条都不推/);
  assert.equal(engines.indexNow.length, 0);
  assert.doesNotMatch(wrong.out, /\n\s+at /, '预期中的错误不打栈');

  engines.reset();
  engines.keyBody = null;
  const missing = await run({ ...ws.env, ...engines.env, ...ENABLED });
  assert.equal(missing.status, 1, missing.out);
  assert.match(missing.out, /key 文件不在线上：.*回 HTTP 404/);
  assert.equal(engines.indexNow.length, 0);

  // 站点源根本连不上：同样退 1、零推送，错误带原因码
  engines.reset();
  const down = await run({ ...ws.env, ...engines.env, ...ENABLED, SITE_ORIGIN: await closedOrigin() });
  assert.equal(down.status, 1, down.out);
  assert.match(down.out, /取不到 key 文件 http:\/\/127\.0\.0\.1:\d+\/.*ECONNREFUSED/);
  assert.equal(engines.indexNow.length, 0);

  engines.reset();
  engines.keyBody = null;
  const skipped = await run({ ...ws.env, ...engines.env, ...ENABLED, SEO_PUSH_SKIP_KEY_CHECK: '1' });
  assert.equal(skipped.status, 0, skipped.out);
  assert.match(skipped.out, /SEO_PUSH_SKIP_KEY_CHECK=1：跳过 key 文件核对/);
  assert.equal(engines.site.length, 0, '没去取 key 文件');
  assert.equal(engines.indexNow.length, 1);
});

test('push:search：IndexNow 失败（403 / 连不上）退 1；无配置退 0；没有新增页面退 0', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const engines = await fakeEngines();
  t.after(engines.close);

  engines.indexNowStatus = 403;
  const denied = await run({ ...ws.env, ...engines.env, ...ENABLED });
  assert.equal(denied.status, 1, denied.out);
  assert.match(denied.out, /IndexNow（2 条）：key 校验失败（403）/);
  assert.match(denied.out, /IndexNow 推送失败/);

  engines.reset();
  const down = await run({ ...ws.env, ...engines.env, ...ENABLED, INDEXNOW_ENDPOINT: `${await closedOrigin()}/indexnow` });
  assert.equal(down.status, 1, down.out);
  assert.match(down.out, /IndexNow（2 条）：请求失败：.*ECONNREFUSED/);

  // 仓库配置里 indexnow_key 是空串：什么都不推
  engines.reset();
  const none = await run({ ...ws.env, ...engines.env });
  assert.equal(none.status, 0, none.out);
  assert.match(none.out, /IndexNow：site\.config\.yaml 的 seo\.indexnow_key 为空，不推/);
  assert.match(none.out, /没配置 IndexNow（seo\.indexnow_key 为空），本步骤无事可做/);
  assert.equal(engines.indexNow.length + engines.site.length, 0);

  // 上一版与本版页面相同：没有新增
  const same = await workspace(t, { previous: { ...CURRENT, version: '2026-09-03.1' } });
  const nothing = await run({ ...same.env, ...engines.env, ...ENABLED });
  assert.equal(nothing.status, 0, nothing.out);
  assert.match(nothing.out, /新增 0 条/);
  assert.match(nothing.out, /没有新增页面，不发请求/);
  assert.equal(engines.indexNow.length + engines.site.length, 0);
});

test('push:search：--dry-run 与 SEO_PUSH_DRY_RUN=1 只打印将推什么，零请求、退 0', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const engines = await fakeEngines();
  t.after(engines.close);
  for (const [args, extra, re] of [
    [['--dry-run'], {}, /--dry-run：只打印，未发任何请求/],
    [[], { SEO_PUSH_DRY_RUN: '1' }, /SEO_PUSH_DRY_RUN=1：只打印，未发任何请求/],
  ]) {
    const r = await run({ ...ws.env, ...engines.env, ...ENABLED, ...extra }, args);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, re);
    assert.match(r.out, /将推 2 条 URL：/);
    for (const u of NEW_URLS) assert.ok(r.out.includes(u), u);
    assert.match(r.out, /IndexNow：2 条，1 批；host=/);
    assert.equal(engines.indexNow.length + engines.site.length, 0, '一个请求都不发（连 key 文件都不取）');
  }
});

test('push:search：manifest 缺退 1；manifest-previous 坏退 1；--all 无视坏文件；非法参数 / key 退 1', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const engines = await fakeEngines();
  t.after(engines.close);

  const empty = join(ws.tmp, 'empty-out');
  await mkdir(empty);
  const noManifest = await run({ OUT_DIR: empty, ...engines.env, ...ENABLED });
  assert.equal(noManifest.status, 1, noManifest.out);
  assert.match(noManifest.out, /manifest\.json 不存在/);

  const broken = await workspace(t, { previous: null });
  await writeFile(join(broken.OUT, MANIFEST_PREVIOUS_FILE), '{not json');
  const bad = await run({ ...broken.env, ...engines.env, ...ENABLED });
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /manifest-previous\.json 不是合法 JSON/);
  assert.match(bad.out, /--all/);
  assert.equal(engines.indexNow.length, 0, '坏文件不能变成「推全部」');
  // --all 无视坏文件
  const forced = await run({ ...broken.env, ...engines.env, ...ENABLED }, ['--all']);
  assert.equal(forced.status, 0, forced.out);
  assert.equal(engines.indexNow.length, 1);

  engines.reset();
  const badArg = await run({ ...ws.env, ...engines.env, ...ENABLED }, ['--nope']);
  assert.equal(badArg.status, 1, badArg.out);
  assert.match(badArg.out, /不认识的参数：--nope/);
  const badKey = await run({ ...ws.env, ...engines.env, ...ENABLED, INDEXNOW_KEY: 'short' });
  assert.equal(badKey.status, 1, badKey.out);
  assert.match(badKey.out, /IndexNow key 必须是 8–128 位/);
  assert.equal(engines.indexNow.length + engines.site.length, 0);
});

test('push:search：key 文件核对会重试——部署刚结束时先 404、第二次才有，仍然推成功；试满次数还不对才退 1', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const engines = await fakeEngines();
  t.after(engines.close);
  engines.keyDelayVisits = 1;
  const r = await run({ ...ws.env, ...engines.env, ...ENABLED, SEO_PUSH_KEY_RETRIES: '3', SEO_PUSH_KEY_RETRY_MS: '20' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /第 1\/3 次核对未通过（HTTP 404）/);
  assert.match(r.out, /key 文件核对通过/);
  assert.equal(engines.site.filter((v) => v.endsWith('.txt')).length, 2, '第二次取到就不再试');
  assert.equal(engines.indexNow.length, 1);

  engines.reset();
  engines.keyDelayVisits = 10;
  const r2 = await run({ ...ws.env, ...engines.env, ...ENABLED, SEO_PUSH_KEY_RETRIES: '2', SEO_PUSH_KEY_RETRY_MS: '20' });
  assert.equal(r2.status, 1);
  assert.match(r2.out, /已试 2 次/);
  assert.equal(engines.site.filter((v) => v.endsWith('.txt')).length, 2);
  assert.equal(engines.indexNow.length, 0, '试满仍不对：一条都不推');
});
