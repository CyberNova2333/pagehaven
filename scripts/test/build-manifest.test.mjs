// build:manifest 的端到端测试：DATA_DIR 指到样本、OUT_DIR 指到临时目录，真 spawn 脚本。
//
// 对象存储清单核对那条路不 mock SDK：起一个本地 HTTP 假 S3（只会答 ListObjectsV2，且故意把
// 每页压到 5 个 key 逼出翻页），用 R2_ENDPOINT 把脚本指过去。这样验的是「真 SDK + 真分页 +
// 真退出码」，而不是某个函数被调用了几次。不连任何外部服务，不碰仓库根的 data/ dist/ out/。
//
// 域名与前缀的期望值从仓库的 site.config.yaml 读（脚本经 loadSiteConfig 读的是固定路径，
// 测试指不到临时配置）：维护者把示例域名换成真域名时，这些与改动无关的断言不该跟着红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../lib/config.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const SCRIPT = join(ROOT, 'scripts', 'build-manifest.mjs');
const CREDS = {
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'sk',
  R2_BUCKET: 'test-bucket',
};
const CONFIG = await loadSiteConfig();
const IMG = CONFIG.images.prefix;
const DB = CONFIG.db.prefix;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 样本里 8 页 × avif/webp = 16 个 key；与 packages/core 的模型拼法一致。 */
const SAMPLE_KEYS = [
  ['sample/vol01/c001', ['0123456789ab', '123456789abc', '23456789abcd']],
  ['sample/vol01/c002', ['3456789abcde', '456789abcdef']],
  ['sample/vol02/c003', ['56789abcdef0']],
  ['zeta/v1/ch1', ['6789abcdef01', '789abcdef012']],
].flatMap(([chapter, hashes]) =>
  hashes.flatMap((h, i) => [`${IMG}${chapter}/${i + 1}-${h}.avif`, `${IMG}${chapter}/${i + 1}-${h}.webp`]),
);

/** 干净的环境：去掉本机 / Actions 里可能存在的凭据与版本变量，脚本的行为只由测试给的决定。 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(R2_|RELEASE_|DATA_DIR$|DIST_DIR$|OUT_DIR$)/.test(k)) delete env[k];
  return env;
}

/**
 * 异步 spawn 而不是 spawnSync：假 S3 就住在这个测试进程里，spawnSync 会把事件循环卡住，
 * 服务器答不了话、子进程等回应——死锁。
 */
function run(env, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
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

/**
 * 本地假 S3：只实现 ListObjectsV2（GET /<bucket>/?list-type=2），每页 pageSize 个 key，
 * continuation-token 就是下一页的起始下标。桶名对不上回 404——顺带验证客户端真按路径式寻址。
 */
async function fakeS3(keys, { pageSize = 5 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const isList =
      req.method === 'GET' && url.pathname === `/${CREDS.R2_BUCKET}/` && url.searchParams.get('list-type') === '2';
    if (!isList) {
      res.writeHead(404);
      res.end();
      return;
    }
    const prefix = url.searchParams.get('prefix') ?? '';
    const start = Number(url.searchParams.get('continuation-token') ?? 0);
    const all = keys.filter((k) => k.startsWith(prefix)).sort();
    const page = all.slice(start, start + pageSize);
    const truncated = start + pageSize < all.length;
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      `<Name>${CREDS.R2_BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount>` +
      `<MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
      (truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : '') +
      page.map((k) => `<Contents><Key>${k}</Key><Size>${k.length}</Size><ETag>"e"</ETag></Contents>`).join('') +
      '</ListBucketResult>';
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(xml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    env: { ...CREDS, R2_ENDPOINT: `http://127.0.0.1:${server.address().port}` },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('build:manifest：样本 → manifest.json，形状与键顺序稳定；无凭据时退出 0 并如实提示未校验', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-manifest-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  // OUT_DIR 指向一个还不存在的多级目录：脚本自己建
  const OUT = join(tmp, 'nested', 'out');
  const before = Date.now();
  const r = await run({ DATA_DIR: FIXTURES, OUT_DIR: OUT, RELEASE_VERSION: '2026-09-03' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /未校验对象存储清单：没有写凭据/);
  // 提示说的是事实：在哪一步核对取决于 R2_* 传给了谁，不能断言「release.yml 里会校验」
  assert.match(r.out, /把 R2_\* 传给跑本脚本的那一步才会在此核对/);
  assert.match(r.out, /publish:r2/);
  assert.match(r.out, /16 个图片 key（8 页 × avif\/webp）/);

  const text = await readFile(join(OUT, 'manifest.json'), 'utf8');
  assert.ok(text.endsWith('}\n'));
  const m = JSON.parse(text);
  assert.deepEqual(
    Object.keys(m),
    ['version', 'generatedAt', 'site', 'images', 'totals', 'series', 'imageKeys', 'db'],
    '顶层键顺序',
  );
  assert.equal(m.version, '2026-09-03');
  assert.match(m.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(m.generatedAt) >= before - 1000 && Date.parse(m.generatedAt) <= Date.now() + 1000);
  assert.deepEqual(m.site, { domain: CONFIG.site.domain });
  assert.deepEqual(m.images, { hosts: CONFIG.images.hosts, prefix: IMG });
  assert.deepEqual(m.totals, { series: 2, issues: 3, chapters: 4, pages: 8, boxes: 5 });
  assert.equal(m.db, null, 'db 字段留给 build:db');

  await t.test('series 树：作品 / 期 / 话与 URL，话只带 key / url / 页数 / hasText', () => {
    assert.deepEqual(m.series.map((s) => s.id), ['zeta', 'sample'], '按模型顺序（zeta sort=0 在前）');
    assert.deepEqual(Object.keys(m.series[0]), ['id', 'title', 'url', 'issues']);
    assert.deepEqual(Object.keys(m.series[0].issues[0]), ['id', 'number', 'title', 'published', 'url', 'chapters']);
    assert.deepEqual(m.series[0].issues[0].published, null, '没有 published 写 null');
    assert.deepEqual(m.series[0].issues[0].chapters, [
      { key: 'zeta/v1/ch1', url: '/zeta/v1/ch1/', pages: 2, hasText: true },
    ]);
    const sample = m.series[1];
    assert.equal(sample.title, '示例作品');
    assert.equal(sample.url, '/sample/');
    assert.deepEqual(sample.issues.map((i) => [i.id, i.number, i.title, i.published, i.url]), [
      ['vol01', 1, '第一卷', '2026-01-01', '/sample/vol01/'],
      ['vol02', 2, '第二卷', '2026-06-01', '/sample/vol02/'],
    ]);
    assert.deepEqual(sample.issues[0].chapters, [
      { key: 'sample/vol01/c001', url: '/sample/vol01/c001/', pages: 3, hasText: true },
      { key: 'sample/vol01/c002', url: '/sample/vol01/c002/', pages: 2, hasText: true },
    ]);
    assert.deepEqual(sample.issues[1].chapters, [
      { key: 'sample/vol02/c003', url: '/sample/vol02/c003/', pages: 1, hasText: false },
    ]);
  });

  await t.test('imageKeys：页数 × 2、已按字节序排序、与模型的 key 拼法一致', () => {
    assert.equal(m.imageKeys.length, m.totals.pages * 2);
    assert.deepEqual(m.imageKeys, [...m.imageKeys].sort(), '已排序');
    assert.deepEqual(m.imageKeys, [...SAMPLE_KEYS].sort());
    const shape = new RegExp(`^${escapeRe(IMG)}[a-z0-9-]+/[a-z0-9-]+/[a-z0-9-]+/\\d+-[0-9a-f]{12}\\.(avif|webp)$`);
    for (const k of m.imageKeys) assert.match(k, shape);
  });

  await t.test('再跑一次：除 generatedAt 外逐字节相同（键顺序与排序都是确定的）', async () => {
    const r2 = await run({ DATA_DIR: FIXTURES, OUT_DIR: OUT, RELEASE_VERSION: '2026-09-03' });
    assert.equal(r2.status, 0, r2.out);
    const again = JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8'));
    assert.deepEqual({ ...again, generatedAt: null }, { ...m, generatedAt: null });
  });
});

test('版本：RELEASE_VERSION 缺省用 UTC 日期；带路径分隔符的拒收且不写文件', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-manifest-version-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OUT = join(tmp, 'out');
  const r = await run({ DATA_DIR: FIXTURES, OUT_DIR: OUT, RELEASE_VERSION: '' });
  assert.equal(r.status, 0, r.out);
  const m = JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8'));
  assert.match(m.version, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(m.version, m.generatedAt.slice(0, 10));

  const OUT2 = join(tmp, 'out2');
  const bad = await run({ DATA_DIR: FIXTURES, OUT_DIR: OUT2, RELEASE_VERSION: '../evil' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /RELEASE_VERSION/);
  assert.ok(!existsSync(join(OUT2, 'manifest.json')));
});

test('0 话：空 data/ 也写出合法 manifest（空树、空 imageKeys）', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-manifest-empty-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const r = await run({ DATA_DIR: join(tmp, 'data'), OUT_DIR: join(tmp, 'out'), RELEASE_VERSION: 'v0' });
  assert.equal(r.status, 0, r.out);
  const m = JSON.parse(await readFile(join(tmp, 'out', 'manifest.json'), 'utf8'));
  assert.deepEqual(m.series, []);
  assert.deepEqual(m.imageKeys, []);
  assert.deepEqual(m.totals, { series: 0, issues: 0, chapters: 0, pages: 0, boxes: 0 });
});

test('data/ 不合法：报错退出，不写 manifest', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-manifest-bad-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await mkdir(join(tmp, 'data', 'meta'), { recursive: true });
  await writeFile(join(tmp, 'data', 'meta', 'bad.yaml'), 'id: other\ntitle: x\n');
  const r = await run({ DATA_DIR: join(tmp, 'data'), OUT_DIR: join(tmp, 'out') });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /bad\.yaml/);
  assert.ok(!existsSync(join(tmp, 'out', 'manifest.json')));
});

test('有凭据：对着本地假 S3 分页列清单核对；全都在 → 0，缺了 → 列出并非零退出', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-manifest-r2-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OK_OUT = join(tmp, 'ok');

  await t.test('全部 key 都在（外加不相干的对象）；上次留下的 missing-images.txt 被清掉', async () => {
    const extras = [`${IMG}other/x/y/1-aaaaaaaaaaaa.avif`, `${DB}gallery-2026-09-01.sqlite`];
    const s3 = await fakeS3([...SAMPLE_KEYS, ...extras], { pageSize: 5 });
    try {
      await mkdir(OK_OUT, { recursive: true });
      await writeFile(join(OK_OUT, 'missing-images.txt'), 'stale\n');
      const r = await run({ DATA_DIR: FIXTURES, OUT_DIR: OK_OUT, RELEASE_VERSION: '2026-09-03', ...s3.env });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /对象存储清单核对通过：manifest 引用的 16 个图片 key 全部存在/);
      assert.ok(r.out.includes(`${IMG} 下 17 个对象`), r.out);
      assert.doesNotMatch(r.out, /未校验/);
      assert.ok(!existsSync(join(OK_OUT, 'missing-images.txt')), '通过了就不该留着旧的缺 key 列表');
      // 真翻了页：17 个 key、每页 5 个 → 4 次请求，后三次带 continuation-token，只列图片前缀
      assert.equal(s3.requests.length, 4, s3.requests.join('\n'));
      const want = `prefix=${encodeURIComponent(IMG)}`;
      assert.ok(s3.requests.every((q) => q.includes(want)), s3.requests.join('\n'));
      assert.equal(s3.requests.filter((q) => q.includes('continuation-token=')).length, 3);
    } finally {
      await s3.close();
    }
  });

  await t.test('缺两个 key：控制台列出、完整列表写到 missing-images.txt、退出码非零、manifest 仍已写出', async () => {
    const missing = [`${IMG}sample/vol01/c002/2-456789abcdef.webp`, `${IMG}zeta/v1/ch1/1-6789abcdef01.avif`];
    const s3 = await fakeS3(SAMPLE_KEYS.filter((k) => !missing.includes(k)));
    try {
      const OUT = join(tmp, 'missing');
      const r = await run({ DATA_DIR: FIXTURES, OUT_DIR: OUT, RELEASE_VERSION: '2026-09-03', ...s3.env });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /2 个对象存储里不存在的图片 key/);
      for (const k of missing) assert.ok(r.out.includes(`缺 ${k}`), `应列出 ${k}：\n${r.out}`);
      assert.match(r.out, /完整列表：.*missing-images\.txt/);
      assert.doesNotMatch(r.out, /核对通过/);
      assert.ok(existsSync(join(OUT, 'manifest.json')));
      assert.equal(await readFile(join(OUT, 'missing-images.txt'), 'utf8'), [...missing].sort().join('\n') + '\n');
    } finally {
      await s3.close();
    }
  });

  await t.test('凭据齐全但存储不可达：报错退出，不算「未校验」', async () => {
    const s3 = await fakeS3([]);
    await s3.close(); // 端口已释放：连接会被拒绝
    const r = await run({ DATA_DIR: FIXTURES, OUT_DIR: join(tmp, 'down'), RELEASE_VERSION: '2026-09-03', ...s3.env });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.out, /未校验/);
    assert.doesNotMatch(r.out, /核对通过/);
  });

  await t.test('--verify-only：只核对已有的 manifest，不读 data/、不重写（build:db 填的 db 字段保住）', async () => {
    // 模拟 build:db 已经填过 db 字段
    const path = join(OK_OUT, 'manifest.json');
    const m = JSON.parse(await readFile(path, 'utf8'));
    m.db = {
      version: '2026-09-03',
      key: `${DB}gallery-2026-09-03.sqlite`,
      size: 1,
      sha256: 'x',
      pageSize: 4096,
      chunkSize: 65536,
      chunks: 'c',
    };
    const filled = JSON.stringify(m, null, 2) + '\n';
    await writeFile(path, filled);

    const s3 = await fakeS3(SAMPLE_KEYS);
    try {
      // DATA_DIR 指到不存在的目录：证明这条路根本不读 data/
      const env = { DATA_DIR: join(tmp, 'no-such-data'), OUT_DIR: OK_OUT, RELEASE_VERSION: 'ignored', ...s3.env };
      const r = await run(env, ['--verify-only']);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /只核对，不重写/);
      assert.match(r.out, /核对通过：manifest 引用的 16 个图片 key 全部存在/);
      assert.equal(await readFile(path, 'utf8'), filled, 'manifest.json 一字未动');
      assert.ok(s3.requests.length >= 1 && s3.requests.every((q) => q.includes(`prefix=${encodeURIComponent(IMG)}`)));
    } finally {
      await s3.close();
    }

    const missingOne = await fakeS3(SAMPLE_KEYS.slice(1));
    try {
      const r = await run({ OUT_DIR: OK_OUT, ...missingOne.env }, ['--verify-only']);
      assert.equal(r.status, 1, r.out);
      assert.ok(r.out.includes(`缺 ${SAMPLE_KEYS[0]}`), r.out);
      assert.equal(await readFile(join(OK_OUT, 'missing-images.txt'), 'utf8'), `${SAMPLE_KEYS[0]}\n`);
      assert.equal(await readFile(path, 'utf8'), filled, '失败时也不重写');
    } finally {
      await missingOne.close();
    }
  });

  await t.test('--verify-only：没有凭据是配置错误（不是「未校验」）；没有 manifest 也报错', async () => {
    const noCreds = await run({ OUT_DIR: OK_OUT }, ['--verify-only']);
    assert.notEqual(noCreds.status, 0);
    assert.match(noCreds.out, /--verify-only 需要对象存储写凭据/);
    assert.doesNotMatch(noCreds.out, /未校验/);

    const noManifest = await run({ OUT_DIR: join(tmp, 'empty'), ...CREDS }, ['--verify-only']);
    assert.notEqual(noManifest.status, 0);
    assert.match(noManifest.out, /manifest\.json 不存在/);
  });
});
