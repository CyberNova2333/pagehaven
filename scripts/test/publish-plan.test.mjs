// 上传计划的单测 + publish:r2 脚本的端到端。
//
// 计划是纯函数：key / Content-Type / Cache-Control / 顺序 / 图片取舍 / 各种对不上，直接比对。
// 脚本那部分对着本地假 S3（只答 PUT、HEAD 与 GET，后两者可切成一律回 500）发真请求，验的是真上传时带的头、
// 已存在的图片被跳过、缺图或存储报错时 manifest 不换指针、manifest 永远最后一个传、经符号链接挂进
// IMAGES_DIR 的图片也会传、线上旧 manifest 在任何上传之前被原样存下。dist 归档要 tar --zstd：这台机器未必有 zstd，
// 所以在 PATH 前面放一个直通的 zstd 替身（exec cat），tar 真被起、真打包、真上传；再用一个只有
// tar 的 PATH 验「zstd 不可用就报错且一个字节都不传」。不连任何外部服务，不碰仓库根的 dist/ out/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../lib/config.mjs';
import {
  planUploads,
  dbFileNames,
  archiveFileName,
  CACHE_IMMUTABLE_YEAR,
  CACHE_MANIFEST,
  CONTENT_TYPE_OCTET,
  CONTENT_TYPE_MANIFEST,
  CONTENT_TYPE_ARCHIVE,
} from '../lib/publish-plan.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'publish-r2.mjs');
const VERSION = '2026-09-03';
const KEYS = {
  webp: 'img/sample/vol01/c001/1-0123456789ab.webp',
  webp2: 'img/zeta/v1/ch1/1-6789abcdef01.webp',
};
const CREDS = { R2_ACCOUNT_ID: 'test-account', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk', R2_BUCKET: 'test-bucket' };

function manifest(overrides = {}) {
  return {
    version: VERSION,
    generatedAt: '2026-09-03T04:00:00.000Z',
    site: { domain: 'gallery.example.org' },
    images: { hosts: ['img.example.org'], prefix: 'img/' },
    totals: { series: 1, issues: 1, chapters: 1, pages: 1, boxes: 0 },
    series: [],
    imageKeys: [KEYS.webp, KEYS.webp2],
    db: {
      version: VERSION,
      key: 'db/gallery-2026-09-03.sqlite',
      size: 8192,
      sha256: '00'.repeat(32),
      pageSize: 4096,
      chunkSize: 65536,
      chunks: 'db/gallery-2026-09-03.sqlite.chunks.json',
    },
    ...overrides,
  };
}

const config = await loadSiteConfig();
const FILES = {
  db: ['/out/db/gallery-2026-09-03.sqlite', '/out/db/gallery-2026-09-03.sqlite.chunks.json'],
  manifest: '/out/manifest.json',
  distArchive: '/out/site-2026-09-03.tar.zst',
  images: null,
};

test('dbFileNames / archiveFileName：与 build:db、ARCHITECTURE §5 的命名一致', async () => {
  assert.deepEqual(dbFileNames(VERSION), { db: 'gallery-2026-09-03.sqlite', chunks: 'gallery-2026-09-03.sqlite.chunks.json' });
  assert.equal(archiveFileName(VERSION), 'site-2026-09-03.tar.zst');
});

test('planUploads：key / Content-Type / Cache-Control；库与摘要 immutable 且 octet-stream，manifest 5 分钟且最后', async () => {
  const plan = planUploads({ version: VERSION, config, manifest: manifest(), files: FILES });
  assert.equal(plan.version, VERSION);
  assert.deepEqual(
    plan.uploads.map((u) => [u.kind, u.key, u.path, u.contentType, u.cacheControl, u.skipIfExists]),
    [
      ['db', 'db/gallery-2026-09-03.sqlite', FILES.db[0], CONTENT_TYPE_OCTET, CACHE_IMMUTABLE_YEAR, false],
      ['chunks', 'db/gallery-2026-09-03.sqlite.chunks.json', FILES.db[1], CONTENT_TYPE_OCTET, CACHE_IMMUTABLE_YEAR, false],
      ['archive', 'archive/site-2026-09-03.tar.zst', FILES.distArchive, CONTENT_TYPE_ARCHIVE, CACHE_IMMUTABLE_YEAR, false],
      ['manifest', 'db/manifest.json', FILES.manifest, CONTENT_TYPE_MANIFEST, CACHE_MANIFEST, false],
    ],
  );
  assert.equal(CACHE_IMMUTABLE_YEAR, 'public, max-age=31536000, immutable');
  assert.equal(CACHE_MANIFEST, 'public, max-age=300');
  assert.equal(CONTENT_TYPE_OCTET, 'application/octet-stream');
  assert.deepEqual(plan.verifyKeys, [KEYS.webp, KEYS.webp2]);
  assert.notEqual(plan.verifyKeys, manifest().imageKeys, '是副本');
  assert.deepEqual(plan.images, { dir: false, uploads: 0, ignored: [], unsupported: [] });
  // out/db 的顺序无关：反过来给也一样
  const swapped = planUploads({ version: VERSION, config, manifest: manifest(), files: { ...FILES, db: [...FILES.db].reverse() } });
  assert.deepEqual(swapped.uploads, plan.uploads);
});

test('planUploads：图片只传 manifest 引用的，按 key 排序、先查再传；没引用的与扩展名不认的分开列', async () => {
  const images = [
    'zeta/v1/ch1/1-6789abcdef01.webp',
    'sample\\vol01\\c001\\1-0123456789ab.webp', // Windows 分隔符也认
    'sample/vol01/c001/2-ffffffffffff.webp', // manifest 没引用（还没进 meta 的页）
    'stray.png',
  ];
  const plan = planUploads({ version: VERSION, config, manifest: manifest(), files: { ...FILES, images } });
  const imgs = plan.uploads.filter((u) => u.kind === 'image');
  assert.deepEqual(
    imgs.map((u) => [u.key, u.path, u.contentType, u.cacheControl, u.skipIfExists]),
    [
      [KEYS.webp, 'sample\\vol01\\c001\\1-0123456789ab.webp', 'image/webp', CACHE_IMMUTABLE_YEAR, true],
      [KEYS.webp2, 'zeta/v1/ch1/1-6789abcdef01.webp', 'image/webp', CACHE_IMMUTABLE_YEAR, true],
    ],
  );
  assert.deepEqual(plan.images, { dir: true, uploads: 2, ignored: ['sample/vol01/c001/2-ffffffffffff.webp', 'stray.png'], unsupported: [] });
  // 图片在归档之后、manifest 之前
  assert.deepEqual(plan.uploads.map((u) => u.kind), ['db', 'chunks', 'archive', 'image', 'image', 'manifest']);

  // manifest 引用了一个扩展名不认的 key（不该发生，但不能静默当成图传）
  const odd = planUploads({
    version: VERSION,
    config,
    manifest: manifest({ imageKeys: ['img/x/y/z/1-0123456789ab.png'] }),
    files: { ...FILES, images: ['x/y/z/1-0123456789ab.png'] },
  });
  assert.deepEqual(odd.images, { dir: true, uploads: 0, ignored: [], unsupported: ['x/y/z/1-0123456789ab.png'] });
});

test('planUploads：版本对不上、没 db 字段、库文件多了少了——一次列全并抛', async () => {
  const expectIssues = (input, patterns) => {
    assert.throws(
      () => planUploads(input),
      (e) => {
        assert.equal(e.issues.length, patterns.length, e.message);
        patterns.forEach((re, i) => assert.match(e.issues[i], re));
        return true;
      },
    );
  };
  expectIssues({ version: '2026-09-04', config, manifest: manifest(), files: FILES }, [
    /版本是 2026-09-03，本次发布版本是 2026-09-04/,
    /db\.key 是 db\/gallery-2026-09-03\.sqlite，本次应为 db\/gallery-2026-09-04\.sqlite/,
    /db\.chunks/,
    /没有 gallery-2026-09-04\.sqlite（/,
    /没有 gallery-2026-09-04\.sqlite\.chunks\.json/,
    /不属于本版本的文件 gallery-2026-09-03\.sqlite（/,
    /不属于本版本的文件 gallery-2026-09-03\.sqlite\.chunks\.json/,
  ]);
  expectIssues({ version: VERSION, config, manifest: manifest({ db: null }), files: FILES }, [/没有 db 字段/]);
  expectIssues({ version: VERSION, config, manifest: manifest(), files: { ...FILES, db: [FILES.db[0], '/out/db/gallery-old.sqlite'] } }, [
    /没有 gallery-2026-09-03\.sqlite\.chunks\.json/,
    /不属于本版本的文件 gallery-old\.sqlite/,
  ]);
  expectIssues({ version: VERSION, config, manifest: manifest({ imageKeys: undefined }), files: FILES }, [/没有 imageKeys/]);
  // 名字对得上、大小对不上：manifest 与库来自不同次构建
  expectIssues({ version: VERSION, config, manifest: manifest(), files: { ...FILES, dbSize: 8191 } }, [
    /记的库大小是 8192 字节，out\/db 里的 gallery-2026-09-03\.sqlite 实际 8191 字节/,
  ]);
  assert.equal(planUploads({ version: VERSION, config, manifest: manifest(), files: { ...FILES, dbSize: 8192 } }).uploads.length, 4, '大小相等不是问题');
  assert.equal(planUploads({ version: VERSION, config, manifest: manifest(), files: FILES }).uploads.length, 4, '没给大小就不比');
});

// ── publish:r2 脚本 ─────────────────────────────────────────────────

/** 干净的环境：去掉本机 / CI 里可能存在的凭据与开关，行为只由测试给的决定。 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(R2_|RELEASE_|PUBLISH_|IMAGES_DIR$|DATA_DIR$|DIST_DIR$|OUT_DIR$)/.test(k)) delete env[k];
  return env;
}

/**
 * 异步 spawn 而不是 spawnSync：假 S3 就住在这个测试进程里，spawnSync 会把事件循环卡住，
 * 服务器答不了话、子进程等回应——死锁。
 */
function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env: { ...cleanEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** 一个临时工作区：out/manifest.json + out/db 一对文件、dist/、images/ 里只有 webp。 */
async function workspace(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-publish-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OUT = join(tmp, 'out');
  const DIST = join(tmp, 'dist');
  const IMAGES = join(tmp, 'images');
  await mkdir(join(OUT, 'db'), { recursive: true });
  await mkdir(join(DIST, 'sample'), { recursive: true });
  await mkdir(join(IMAGES, 'sample', 'vol01', 'c001'), { recursive: true });
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest(), null, 2) + '\n');
  await writeFile(join(OUT, 'db', 'gallery-2026-09-03.sqlite'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192 - 16)]));
  await writeFile(join(OUT, 'db', 'gallery-2026-09-03.sqlite.chunks.json'), '{"version":1}\n');
  await writeFile(join(DIST, 'index.html'), '<!doctype html><title>首页</title>\n');
  await writeFile(join(DIST, 'sample', 'index.html'), '<!doctype html>\n');
  await writeFile(join(IMAGES, 'sample', 'vol01', 'c001', '1-0123456789ab.webp'), Buffer.from('webp-bytes'));
  await writeFile(join(IMAGES, 'unreferenced.webp'), Buffer.from('x'));
  // 经符号链接挂进来的图片目录（CI / Codespaces 里 ln -s 很常见）：里面是 webp2
  const LINKED = join(tmp, 'linked', 'zeta', 'v1', 'ch1');
  await mkdir(LINKED, { recursive: true });
  await writeFile(join(LINKED, '1-6789abcdef01.webp'), Buffer.from('webp2-bytes'));
  await symlink(join(tmp, 'linked', 'zeta'), join(IMAGES, 'zeta'), 'dir');
  // 一条指回祖先目录的链接：跟着符号链接走就得防转圈，它不该让脚本挂死，也不该往计划里塞重复项
  await symlink(IMAGES, join(IMAGES, 'sample', 'loop'), 'dir');
  // zstd 替身：直通，让 tar --zstd 在没装 zstd 的机器上也能真跑
  const shim = join(tmp, 'bin');
  await mkdir(shim);
  await writeFile(join(shim, 'zstd'), '#!/bin/sh\nexec cat\n');
  await chmod(join(shim, 'zstd'), 0o755);
  return {
    tmp,
    OUT,
    DIST,
    IMAGES,
    archive: join(OUT, archiveFileName(VERSION)),
    env: { OUT_DIR: OUT, DIST_DIR: DIST, RELEASE_VERSION: VERSION, PATH: `${shim}${delimiter}${process.env.PATH}` },
  };
}

/**
 * 本地假 S3：只答 PUT（存起来，连头一起）、HEAD 与 GET（有 → 200，没有 → 404）。
 * 把 headStatus / getStatus 设成 500 之类，HEAD / GET 就一律回那个状态——模拟「存储报错而不是不存在」。
 */
async function fakeS3(seed = {}) {
  const objects = new Map(Object.entries(seed).map(([k, v]) => [k, { body: Buffer.from(v), contentType: null, cacheControl: null }]));
  const requests = [];
  const s3 = { objects, requests, headStatus: null, getStatus: null };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(new RegExp(`^/${CREDS.R2_BUCKET}/(.+)$`));
    const key = m ? decodeURIComponent(m[1]) : null;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      requests.push(`${req.method} ${key ?? url.pathname}`);
      if (!key) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        objects.set(key, { body: Buffer.concat(chunks), contentType: req.headers['content-type'] ?? null, cacheControl: req.headers['cache-control'] ?? null });
        res.writeHead(200, { etag: '"put"' });
        res.end();
        return;
      }
      if (req.method === 'HEAD') {
        if (s3.headStatus) {
          res.writeHead(s3.headStatus);
          res.end();
          return;
        }
        const o = objects.get(key);
        if (!o) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-length': o.body.length, etag: '"e"' });
        res.end();
        return;
      }
      if (req.method === 'GET') {
        if (s3.getStatus) {
          res.writeHead(s3.getStatus);
          res.end();
          return;
        }
        const o = objects.get(key);
        if (!o) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-length': o.body.length, 'content-type': o.contentType ?? 'application/octet-stream', etag: '"e"' });
        res.end(o.body);
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  s3.env = { ...CREDS, R2_ENDPOINT: `http://127.0.0.1:${server.address().port}` };
  s3.close = () => new Promise((resolve) => server.close(resolve));
  return s3;
}

test('publish:r2：没凭据 → 退 1 并说明；PUBLISH_DRY_RUN=1 → 只打印计划、退 0、不建归档', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const r = await run(ws.env);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /没有对象存储写凭据/);
  assert.match(r.out, /不能静默成功/);
  assert.ok(!existsSync(ws.archive), '没凭据时不该开始打包');

  const dry = await run({ ...ws.env, IMAGES_DIR: ws.IMAGES, PUBLISH_DRY_RUN: '1' });
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /PUBLISH_DRY_RUN=1/);
  assert.match(dry.out, /db\/gallery-2026-09-03\.sqlite {2}←.*\[application\/octet-stream; public, max-age=31536000, immutable\]/);
  assert.match(dry.out, /db\/gallery-2026-09-03\.sqlite\.chunks\.json {2}←.*\[application\/octet-stream; public, max-age=31536000, immutable\]/);
  assert.match(dry.out, /archive\/site-2026-09-03\.tar\.zst {2}←.*\[application\/zstd; public, max-age=31536000, immutable\]/);
  assert.match(dry.out, /img\/sample\/vol01\/c001\/1-0123456789ab\.webp {2}←.*\[image\/webp; public, max-age=31536000, immutable; 已存在则跳过\]/);
  assert.match(dry.out, /img\/zeta\/v1\/ch1\/1-6789abcdef01\.webp {2}←.*\[image\/webp; .*已存在则跳过\]/, '符号链接目录里的图片也在计划里');
  assert.match(dry.out, /db\/manifest\.json {2}←.*\[application\/json; charset=utf-8; public, max-age=300\]/);
  assert.match(dry.out, /1 个文件 manifest 没引用，不传：unreferenced\.webp/, '指回祖先的链接没有让文件被重复列出');
  assert.equal(dry.out.match(/img\/sample\/vol01\/c001\/1-0123456789ab\.webp {2}←/g).length, 1, '同一张图只列一次');
  assert.match(dry.out, /归档工具可用：/, 'dry-run 也预检了 tar / zstd');
  assert.ok(!existsSync(ws.archive), 'dry-run 不建归档');
  // dry-run 也做预检：dist 不存在的环境真跑必败，不能说 OK
  const noDist = await run({ ...ws.env, DIST_DIR: join(ws.tmp, 'no-dist'), PUBLISH_DRY_RUN: '1' });
  assert.equal(noDist.status, 1, noDist.out);
  assert.match(noDist.out, /no-dist 不存在：先 npm run build/);
  assert.doesNotMatch(noDist.out, /PUBLISH_DRY_RUN=1：只打印计划/);
  assert.doesNotMatch(noDist.out, /\n\s+at /);
  // manifest 记的库大小与 out/db 里的实际字节数对不上：manifest 与库来自不同次构建
  await writeFile(join(ws.OUT, 'manifest.json'), JSON.stringify(manifest({ db: { ...manifest().db, size: 1 } })));
  const sizeMismatch = await run({ ...ws.env, PUBLISH_DRY_RUN: '1' });
  assert.equal(sizeMismatch.status, 1, sizeMismatch.out);
  assert.match(sizeMismatch.out, /记的库大小是 1 字节，out\/db 里的 gallery-2026-09-03\.sqlite 实际 8192 字节/);
  await writeFile(join(ws.OUT, 'manifest.json'), JSON.stringify(manifest(), null, 2) + '\n');
  // IMAGES_DIR 里有指向不存在目标的符号链接：说清楚是哪个，不打栈
  const dangling = join(ws.tmp, 'dangling-images');
  await mkdir(dangling);
  await symlink(join(ws.tmp, 'nowhere'), join(dangling, 'ghost.webp'));
  const ghost = await run({ ...ws.env, IMAGES_DIR: dangling, PUBLISH_DRY_RUN: '1' });
  assert.equal(ghost.status, 1, ghost.out);
  assert.match(ghost.out, /符号链接指向不存在的目标：ghost\.webp/);
  assert.doesNotMatch(ghost.out, /\n\s+at /);
  // manifest 与计划对不上时 dry-run 也要报：这是配置错误，不是「计划里少一项」
  const bad = await run({ ...ws.env, RELEASE_VERSION: '2026-09-04', PUBLISH_DRY_RUN: '1' });
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /上传计划无法成立/);
  // 没有 IMAGES_DIR 只提示，不算错
  const noImages = await run({ ...ws.env, PUBLISH_DRY_RUN: '1' });
  assert.equal(noImages.status, 0, noImages.out);
  assert.match(noImages.out, /IMAGES_DIR 未设置/);
  // IMAGES_DIR 不是目录 / manifest 不存在：说清楚就退，不打栈
  const notDir = await run({ ...ws.env, IMAGES_DIR: join(ws.tmp, 'nope'), PUBLISH_DRY_RUN: '1' });
  assert.equal(notDir.status, 1, notDir.out);
  assert.match(notDir.out, /IMAGES_DIR=.*不是目录/);
  assert.doesNotMatch(notDir.out, /\n\s+at /);
  const noManifest = await run({ ...ws.env, OUT_DIR: join(ws.tmp, 'empty-out') });
  assert.equal(noManifest.status, 1, noManifest.out);
  assert.match(noManifest.out, /manifest\.json 不存在/);
});

test('publish:r2：真传——缺图不换指针；齐了才传 manifest 且最后；已存在的图片跳过；头正确', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3();
  t.after(s3.close);

  await t.test('第一次：webp 不在存储里 → 传了库/摘要/归档/一个 webp，核对失败退 1，manifest 没传', async () => {
    // 先拿掉 zeta 的 webp，模拟「IMAGES_DIR 缺一张」；第二次再补回来
    await rm(join(ws.tmp, 'linked', 'zeta', 'v1', 'ch1', '1-6789abcdef01.webp'));
    const r = await run({ ...ws.env, ...s3.env, IMAGES_DIR: ws.IMAGES });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /manifest 引用了 1 个对象存储里不存在的图片 key/);
    assert.match(r.out, new RegExp(`缺 ${KEYS.webp2.replace(/[./]/g, '\\$&')}`));
    assert.doesNotMatch(r.out, new RegExp(`缺 ${KEYS.webp.replace(/[./]/g, '\\$&')}`), 'IMAGES_DIR 里的图已传，不该报缺');
    assert.match(r.out, /线上仍指向上一版/);
    assert.ok(!s3.objects.has('db/manifest.json'), 'manifest 不能在缺图时换指针');
    assert.ok(s3.objects.has('db/gallery-2026-09-03.sqlite'));
    assert.ok(s3.objects.has('db/gallery-2026-09-03.sqlite.chunks.json'));
    assert.ok(s3.objects.has('archive/site-2026-09-03.tar.zst'));
    assert.ok(s3.objects.has(KEYS.webp), 'IMAGES_DIR 里的 webp 已传');
    assert.ok(!s3.objects.has(KEYS.webp2), '符号链接目录里还没有 zeta 的 webp');
    assert.match(r.out, /图片：新传 1 个，已存在跳过 0 个/);
    assert.ok(existsSync(ws.archive), '归档留在 out/ 里（release-out 产物会带走）');
  });

  await t.test('对象头：库与摘要 octet-stream + immutable；归档是 tar（替身直通）', async () => {
    const db = s3.objects.get('db/gallery-2026-09-03.sqlite');
    assert.equal(db.contentType, CONTENT_TYPE_OCTET);
    assert.equal(db.cacheControl, CACHE_IMMUTABLE_YEAR);
    assert.equal(db.body.length, 8192);
    assert.equal(db.body.toString('latin1', 0, 16), 'SQLite format 3\0');
    const chunks = s3.objects.get('db/gallery-2026-09-03.sqlite.chunks.json');
    assert.equal(chunks.contentType, CONTENT_TYPE_OCTET, 'chunks.json 也用 octet-stream，逃过 CDN 智能压缩');
    assert.equal(chunks.cacheControl, CACHE_IMMUTABLE_YEAR);
    const archive = s3.objects.get('archive/site-2026-09-03.tar.zst');
    assert.equal(archive.contentType, CONTENT_TYPE_ARCHIVE);
    assert.equal(archive.cacheControl, CACHE_IMMUTABLE_YEAR);
    // 替身不压缩，上传的就是 tar 本体：文件名与 ustar 魔数都在里面
    assert.ok(archive.body.includes(Buffer.from('ustar')), 'tar 头');
    assert.ok(archive.body.includes(Buffer.from('./index.html')), '含 dist 根的 index.html');
    assert.ok(archive.body.includes(Buffer.from('./sample/index.html')), '含子目录');
    const webp = s3.objects.get(KEYS.webp);
    assert.equal(webp.contentType, 'image/webp');
    assert.equal(webp.cacheControl, CACHE_IMMUTABLE_YEAR);
    assert.equal(webp.body.toString(), 'webp-bytes');
  });

  await t.test('第二次：补上缺的图 → 核对通过，已存在的 webp 被跳过，manifest 最后一个传', async () => {
    // 把 zeta 的 webp 补进经符号链接挂进来的目录
    await writeFile(join(ws.tmp, 'linked', 'zeta', 'v1', 'ch1', '1-6789abcdef01.webp'), Buffer.from('webp2-bytes'));
    s3.requests.length = 0;
    const r = await run({ ...ws.env, ...s3.env, IMAGES_DIR: ws.IMAGES });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /图片：新传 1 个，已存在跳过 1 个/);
    assert.match(r.out, /核对通过：manifest 引用的 2 个图片 key 全部存在/);
    assert.match(r.out, /当前版本指针已指向 db\/gallery-2026-09-03\.sqlite/);
    const m = s3.objects.get('db/manifest.json');
    assert.equal(m.contentType, CONTENT_TYPE_MANIFEST);
    assert.equal(m.cacheControl, CACHE_MANIFEST);
    assert.equal(JSON.parse(m.body.toString()).db.key, 'db/gallery-2026-09-03.sqlite');
    // 顺序：库、摘要、归档、新图（zeta），manifest 最后
    const puts = s3.requests.filter((x) => x.startsWith('PUT '));
    assert.deepEqual(puts, ['PUT db/gallery-2026-09-03.sqlite', 'PUT db/gallery-2026-09-03.sqlite.chunks.json', 'PUT archive/site-2026-09-03.tar.zst', `PUT ${KEYS.webp2}`, 'PUT db/manifest.json']);
    assert.equal(s3.requests.at(-1), 'PUT db/manifest.json');
    const heads = s3.requests.filter((x) => x.startsWith('HEAD '));
    assert.deepEqual(heads.sort(), [`HEAD ${KEYS.webp}`, `HEAD ${KEYS.webp2}`, `HEAD ${KEYS.webp}`, `HEAD ${KEYS.webp2}`].sort());
  });

  await t.test('没有 IMAGES_DIR：不传图，只核对；核对通过就换指针', async () => {
    s3.requests.length = 0;
    const r = await run({ ...ws.env, ...s3.env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /IMAGES_DIR 未设置/);
    assert.doesNotMatch(r.out, /图片：新传/);
    assert.equal(s3.requests.filter((x) => x.startsWith('PUT ')).length, 4);
  });

  await t.test('PUT 回 404（桶不存在）→ 抛错、退 1，日志带状态码', async () => {
    // 桶名对不上，假服务器对一切路径回 404：第一个 PUT（库）就是真错误，必须抛，不能当「不存在」
    s3.requests.length = 0;
    const r = await run({ ...ws.env, ...s3.env, R2_BUCKET: 'other-bucket' });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /对象存储回 HTTP 404/);
    assert.doesNotMatch(r.out, /核对通过/);
    assert.equal(s3.requests.filter((x) => x.startsWith('PUT ')).length, 1, '第一个 PUT 失败就停');
  });

  await t.test('核对阶段存储回 500（非 404）→ 抛错退 1、日志带状态码、manifest 不换指针', async () => {
    s3.objects.delete('db/manifest.json');
    s3.headStatus = 500;
    s3.requests.length = 0;
    const r = await run({ ...ws.env, ...s3.env });
    s3.headStatus = null;
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /对象存储回 HTTP 500/);
    assert.match(r.out, /线上仍指向上一版/);
    assert.doesNotMatch(r.out, /核对通过/);
    assert.doesNotMatch(r.out, /缺 img\//, '500 不是「不存在」，不能报成缺 key');
    assert.ok(!s3.objects.has('db/manifest.json'), '核对没过就不能换指针');
    assert.ok(s3.requests.some((x) => x.startsWith('HEAD ')), '确实走到了核对');
  });
});

test('publish:r2：zstd 不可用 → 报错退 1，不换 gzip，一个对象都不传', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3();
  t.after(s3.close);
  // 只有 tar 的 PATH：tar 找得到，zstd 找不到
  const tarPath = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(tarPath, '这台机器得有 tar');
  const onlyTar = join(ws.tmp, 'only-tar');
  await mkdir(onlyTar);
  await symlink(tarPath, join(onlyTar, 'tar'));
  const r = await run({ ...ws.env, ...s3.env, PATH: onlyTar });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /zstd 不可用/);
  assert.match(r.out, /不换 gzip/);
  assert.equal(s3.requests.length, 0, '归档失败时一个请求都没发');
  assert.ok(!existsSync(ws.archive));
  // dry-run 也要发现：预检只跑 --version，无副作用，没理由跳过
  const dry = await run({ ...ws.env, PATH: onlyTar, PUBLISH_DRY_RUN: '1' });
  assert.equal(dry.status, 1, dry.out);
  assert.match(dry.out, /zstd 不可用/);
  assert.doesNotMatch(dry.out, /PUBLISH_DRY_RUN=1：只打印计划/);
});

test('publish:r2：线上旧 manifest 原样存为 out/manifest-previous.json；没有 → 首次发布不写；读失败 → 退 1 且一个对象都不传', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const previousFile = join(ws.OUT, 'manifest-previous.json');
  // 三张图都已在存储里：不给 IMAGES_DIR 也能核对通过、走到换指针
  const s3 = await fakeS3({ [KEYS.webp]: 'a', [KEYS.webp]: 'b', [KEYS.webp2]: 'c' });
  t.after(s3.close);
  // 故意带多字节字符、尾部空白与非 2 空格缩进：验的是逐字节原样，不是「解析后再序列化」
  const OLD = '{\n    "version": "2026-08-01.3",\n  "site": {"domain": "旧域名.example.org"},\n  "db": {"key": "db/gallery-2026-08-01.3.sqlite"}\n}\n  \n';

  await t.test('dry-run 不读存储', async () => {
    const r = await run({ ...ws.env, ...s3.env, PUBLISH_DRY_RUN: '1' });
    assert.equal(r.status, 0, r.out);
    assert.equal(s3.requests.length, 0);
    assert.ok(!existsSync(previousFile));
  });

  await t.test('没有旧 manifest：提示首次发布，文件不存在，脚本仍成功；GET 在任何 PUT 之前', async () => {
    // 上次跑剩下的旧文件要被清掉，不能留给 push:search 当基线
    await writeFile(previousFile, '{"version":"stale"}');
    const r = await run({ ...ws.env, ...s3.env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /首次发布，不写 .*manifest-previous\.json/);
    assert.ok(!existsSync(previousFile), '首次发布不该留下 manifest-previous.json');
    assert.equal(s3.requests[0], 'GET db/manifest.json', '第一个请求就是读旧 manifest');
    assert.equal(s3.requests.filter((x) => x === 'GET db/manifest.json').length, 1);
    assert.equal(s3.requests.at(-1), 'PUT db/manifest.json', '指针照常换');
    assert.ok(s3.objects.has('db/manifest.json'));
  });

  await t.test('有旧 manifest：内容逐字节一致，日志带旧版本号；之后指针才换成新的', async () => {
    s3.objects.set('db/manifest.json', { body: Buffer.from(OLD), contentType: CONTENT_TYPE_MANIFEST, cacheControl: CACHE_MANIFEST });
    s3.requests.length = 0;
    const r = await run({ ...ws.env, ...s3.env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /线上旧 manifest（版本 2026-08-01\.3）已存为 .*manifest-previous\.json/);
    assert.deepEqual(await readFile(previousFile), Buffer.from(OLD), '逐字节原样');
    assert.equal(s3.requests[0], 'GET db/manifest.json');
    assert.equal(s3.requests.at(-1), 'PUT db/manifest.json');
    assert.equal(JSON.parse(s3.objects.get('db/manifest.json').body.toString()).version, VERSION, '线上已是新 manifest');
  });

  await t.test('GET 回 500（不是 404）：退 1、日志带状态码与原因，一个对象都没传、指针没换', async () => {
    s3.objects.set('db/manifest.json', { body: Buffer.from(OLD), contentType: CONTENT_TYPE_MANIFEST, cacheControl: CACHE_MANIFEST });
    s3.getStatus = 500;
    s3.requests.length = 0;
    await rm(ws.archive, { force: true }); // 上面两次成功的运行留下的归档
    const r = await run({ ...ws.env, ...s3.env });
    s3.getStatus = null;
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /对象存储回 HTTP 500/);
    assert.match(r.out, /读线上旧 db\/manifest\.json 失败，不知道线上是哪一版就不能换指针/);
    assert.match(r.out, /manifest\.json 未更新，线上仍指向上一版/);
    assert.equal(s3.requests.filter((x) => x.startsWith('PUT ')).length, 0, '读旧 manifest 失败时一个字节都不传');
    assert.equal(s3.objects.get('db/manifest.json').body.toString(), OLD, '线上指针未动');
    assert.ok(!existsSync(ws.archive), '连归档都没开始');
  });
});
