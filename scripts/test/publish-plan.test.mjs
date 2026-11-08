// 上传计划的单测与发布脚本的端到端测试。
// 使用本机假存储验证条件上传、同版重试、版本冲突、缺图与生产指针隔离。
// 归档由真实 GNU tar 生成；POSIX 环境的 zstd 替身直通，Windows 使用 PATH 中的真实 zstd。
// 临时产物全部位于系统临时目录，不访问外部服务，不碰仓库根 dist/out。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../lib/config.mjs';
import { computeChunkManifest } from '@gallery/core/db/chunks';
import {
  planUploads,
  dbFileNames,
  archiveFileName,
  releaseManifestFileName,
  sameReleaseManifest,
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
const DB_BYTES = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192 - 16)]);
const DB_CHUNKS = await computeChunkManifest(DB_BYTES, 65536);

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
      sha256: DB_CHUNKS.sha256,
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

test('planUploads：key / Content-Type / Cache-Control；库与摘要 immutable 且 octet-stream，版本 manifest 不可变且最后', async () => {
  const plan = planUploads({ version: VERSION, config, manifest: manifest(), files: FILES });
  assert.equal(plan.version, VERSION);
  assert.deepEqual(
    plan.uploads.map((u) => [u.kind, u.key, u.path, u.contentType, u.cacheControl, u.skipIfExists]),
    [
      ['db', 'db/gallery-2026-09-03.sqlite', FILES.db[0], CONTENT_TYPE_OCTET, CACHE_IMMUTABLE_YEAR, true],
      ['chunks', 'db/gallery-2026-09-03.sqlite.chunks.json', FILES.db[1], CONTENT_TYPE_OCTET, CACHE_IMMUTABLE_YEAR, true],
      ['archive', 'archive/site-2026-09-03.tar.zst', FILES.distArchive, CONTENT_TYPE_ARCHIVE, CACHE_IMMUTABLE_YEAR, true],
      ['manifest', 'db/manifest-2026-09-03.json', FILES.manifest, CONTENT_TYPE_MANIFEST, CACHE_IMMUTABLE_YEAR, true],
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
  await writeFile(join(OUT, 'db', 'gallery-2026-09-03.sqlite'), DB_BYTES);
  await writeFile(join(OUT, 'db', 'gallery-2026-09-03.sqlite.chunks.json'), JSON.stringify(DB_CHUNKS) + '\n');
  await writeFile(join(DIST, 'index.html'), '<!doctype html><title>首页</title>\n');
  await writeFile(join(DIST, 'sample', 'index.html'), '<!doctype html>\n');
  await writeFile(join(IMAGES, 'sample', 'vol01', 'c001', '1-0123456789ab.webp'), Buffer.from('webp-bytes'));
  await writeFile(join(IMAGES, 'unreferenced.webp'), Buffer.from('x'));
  // 经符号链接挂进来的图片目录（CI / Codespaces 里 ln -s 很常见）：里面是 webp2
  const LINKED = join(tmp, 'linked', 'zeta', 'v1', 'ch1');
  await mkdir(LINKED, { recursive: true });
  await writeFile(join(LINKED, '1-6789abcdef01.webp'), Buffer.from('webp2-bytes'));
  await symlink(join(tmp, 'linked', 'zeta'), join(IMAGES, 'zeta'), process.platform === 'win32' ? 'junction' : 'dir');
  // 一条指回祖先目录的链接：跟着符号链接走就得防转圈，它不该让脚本挂死，也不该往计划里塞重复项
  await symlink(IMAGES, join(IMAGES, 'sample', 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  // zstd 替身：直通，让 tar --zstd 在没装 zstd 的机器上也能真跑
  const shim = join(tmp, 'bin');
  await mkdir(shim);
  if (process.platform !== 'win32') {
    await writeFile(join(shim, 'zstd'), '#!/bin/sh\nexec cat\n');
    await chmod(join(shim, 'zstd'), 0o755);
  }
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
      await s3.onRequest?.({ method: req.method, key });
      if (!key) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        assert.equal(req.headers['if-none-match'], '*', '每个版本化对象都必须条件创建');
        if (objects.has(key)) {
          res.writeHead(412);
          res.end('<Error><Code>PreconditionFailed</Code></Error>');
          return;
        }
        objects.set(key, { body: Buffer.concat(chunks), contentType: req.headers['content-type'] ?? null, cacheControl: req.headers['cache-control'] ?? null, sha256: req.headers['x-amz-meta-sha256'] });
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
  assert.match(dry.out, /db\/gallery-2026-09-03\.sqlite {2}←.*\[application\/octet-stream; public, max-age=31536000, immutable; 相同内容则跳过\]/);
  assert.match(dry.out, /db\/gallery-2026-09-03\.sqlite\.chunks\.json {2}←.*\[application\/octet-stream; public, max-age=31536000, immutable; 相同内容则跳过\]/);
  assert.match(dry.out, /archive\/site-2026-09-03\.tar\.zst {2}←.*\[application\/zstd; public, max-age=31536000, immutable; 相同内容则跳过\]/);
  assert.match(dry.out, /img\/sample\/vol01\/c001\/1-0123456789ab\.webp {2}←.*\[image\/webp; public, max-age=31536000, immutable; 相同内容则跳过\]/);
  assert.match(dry.out, /img\/zeta\/v1\/ch1\/1-6789abcdef01\.webp {2}←.*\[image\/webp; .*相同内容则跳过\]/, '符号链接目录里的图片也在计划里');
  assert.match(dry.out, /db\/manifest-2026-09-03\.json {2}←.*\[application\/json; charset=utf-8; public, max-age=31536000, immutable; 相同内容则跳过\]/);
  assert.match(dry.out, /1 个文件 manifest 没引用，不传：unreferenced\.webp/, '指回祖先的链接没有让文件被重复列出');
  assert.equal(dry.out.match(/img\/sample\/vol01\/c001\/1-0123456789ab\.webp {2}←/g).length, 1, '同一张图只列一次');
  assert.match(dry.out, /归档工具可用：/, 'dry-run 也预检了 tar / zstd');
  assert.ok(!existsSync(ws.archive), 'dry-run 不建归档');
  // dry-run 也做预检：dist 不存在的环境真跑必败，不能说 OK
  const noDist = await run({ ...ws.env, DIST_DIR: join(ws.tmp, 'no-dist'), PUBLISH_DRY_RUN: '1' });
  assert.equal(noDist.status, 1, noDist.out);
  assert.match(noDist.out, /no-dist 不存在：先 pnpm run build/);
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
  await symlink(join(ws.tmp, 'nowhere'), join(dangling, 'ghost.webp'), process.platform === 'win32' ? 'junction' : 'file');
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


test('manifest 版本命名与等价性：只忽略生成时间，结构或正文变化仍拒绝', () => {
  assert.equal(releaseManifestFileName(VERSION), 'manifest-2026-09-03.json');
  const previous = Buffer.from(JSON.stringify(manifest()));
  assert.ok(sameReleaseManifest(previous, JSON.stringify(manifest({ generatedAt: '2027-01-01T00:00:00Z' }))));
  assert.ok(!sameReleaseManifest(previous, JSON.stringify(manifest({ series: [{ title: '不同' }] }))));
  assert.ok(!sameReleaseManifest(previous, 'null'));
  assert.ok(!sameReleaseManifest(previous, 'invalid'));
});

test('publish:r2：同尺寸损坏与摘要错配在访问存储前拒绝，dry-run 也验证字节', { timeout: 60_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3();
  t.after(s3.close);
  const manifestPath = join(ws.OUT, 'manifest.json');
  const dbPath = join(ws.OUT, 'db', dbFileNames(VERSION).db);
  const chunksPath = join(ws.OUT, 'db', dbFileNames(VERSION).chunks);
  const damaged = Buffer.from(DB_BYTES);
  damaged[512] ^= 1;
  const wrongHash = 'ff'.repeat(32);
  const cases = [
    ['同尺寸单字节损坏', dbPath, damaged, /实际 SHA-256/],
    ['版本清单摘要错配', manifestPath, manifest({ db: { ...manifest().db, sha256: wrongHash } }), /实际 SHA-256/],
    ['分块清单整份摘要错配', chunksPath, { ...DB_CHUNKS, sha256: wrongHash }, /整份 SHA-256/],
    ['仅某块摘要错误', chunksPath, { ...DB_CHUNKS, chunks: [wrongHash] }, /分块 SHA-256/],
    ['分块缺失', chunksPath, { ...DB_CHUNKS, chunks: [] }, /分块 SHA-256/],
    ['分块边界错误', chunksPath, { ...DB_CHUNKS, chunkSize: 4096 }, /块大小/],
    ['数据库版本错误', manifestPath, manifest({ db: { ...manifest().db, version: 'another' } }), /数据库版本/],
    ['无效分块文件', chunksPath, '{broken', /不是有效 JSON/],
  ];
  for (const [name, file, contents, error] of cases) {
    await t.test(name, async () => {
      await writeFile(manifestPath, JSON.stringify(manifest()));
      await writeFile(dbPath, DB_BYTES);
      await writeFile(chunksPath, JSON.stringify(DB_CHUNKS));
      await writeFile(file, Buffer.isBuffer(contents) || typeof contents === 'string' ? contents : JSON.stringify(contents));
      for (const dryRun of ['0', '1']) {
        s3.requests.length = 0;
        const result = await run({ ...ws.env, ...s3.env, PUBLISH_DRY_RUN: dryRun });
        assert.equal(result.status, 1, result.out);
        assert.match(result.out, error);
        assert.equal(s3.requests.length, 0, '不应先上传其他资源或访问存储');
        assert.ok(!existsSync(ws.archive), '完整性失败也不开始归档');
      }
    });
  }
});

test('publish:r2：上传沿用校验过的库、分块与版本清单，读盘后的变化不能偷换字节', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3({ [KEYS.webp]: 'webp-bytes', [KEYS.webp2]: 'webp2-bytes' });
  t.after(s3.close);
  const initialManifest = await readFile(join(ws.OUT, 'manifest.json'));
  const initialChunks = await readFile(join(ws.OUT, 'db', dbFileNames(VERSION).chunks));
  let changed = false;
  s3.onRequest = async ({ method }) => {
    if (changed || method !== 'GET') return;
    changed = true;
    await writeFile(join(ws.OUT, 'db', dbFileNames(VERSION).db), Buffer.alloc(DB_BYTES.length, 1));
    await writeFile(join(ws.OUT, 'db', dbFileNames(VERSION).chunks), '{"version":2}');
    await writeFile(join(ws.OUT, 'manifest.json'), JSON.stringify(manifest({ db: { ...manifest().db, sha256: 'ff'.repeat(32) } })));
  };
  const result = await run({ ...ws.env, ...s3.env });
  assert.equal(result.status, 0, result.out);
  assert.equal(changed, true);
  assert.deepEqual(s3.objects.get(manifest().db.key).body, DB_BYTES);
  assert.deepEqual(s3.objects.get(manifest().db.chunks).body, initialChunks);
  assert.deepEqual(s3.objects.get(`db/${releaseManifestFileName(VERSION)}`).body, initialManifest);
  assert.ok(!s3.objects.has('db/manifest.json'));
});

test('publish:r2：缺图阻止版本 manifest，补图重试幂等，生产指针始终不变', { timeout: 60_000 }, async (t) => {
  const ws = await workspace(t);
  const old = '{"version":"previous"}';
  const s3 = await fakeS3({ 'db/manifest.json': old });
  t.after(s3.close);
  const versionKey = 'db/manifest-2026-09-03.json';
  await rm(join(ws.tmp, 'linked', 'zeta', 'v1', 'ch1', '1-6789abcdef01.webp'));
  const missing = await run({ ...ws.env, ...s3.env, IMAGES_DIR: ws.IMAGES });
  assert.equal(missing.status, 1, missing.out);
  assert.match(missing.out, /manifest 引用了 1 个对象存储里不存在的图片 key/);
  assert.ok(!s3.objects.has(versionKey));
  assert.equal(s3.objects.get('db/manifest.json').body.toString(), old);
  assert.equal(s3.objects.get('db/gallery-2026-09-03.sqlite').contentType, CONTENT_TYPE_OCTET);
  assert.equal(s3.objects.get('db/gallery-2026-09-03.sqlite.chunks.json').cacheControl, CACHE_IMMUTABLE_YEAR);
  const archive = Buffer.from(s3.objects.get('archive/site-2026-09-03.tar.zst').body);
  assert.equal(s3.objects.get('archive/site-2026-09-03.tar.zst').contentType, CONTENT_TYPE_ARCHIVE);
  const contents = spawnSync('tar', ['--force-local', '-tf', ws.archive], { encoding: 'utf8', env: { ...process.env, ...ws.env } });
  assert.equal(contents.status, 0, contents.stderr);
  assert.match(contents.stdout, /\.\/index\.html/);
  assert.match(contents.stdout, /\.\/sample\/index\.html/);

  await writeFile(join(ws.tmp, 'linked', 'zeta', 'v1', 'ch1', '1-6789abcdef01.webp'), Buffer.from('webp2-bytes'));
  await utimes(join(ws.DIST, 'index.html'), new Date('2030-01-01'), new Date('2030-01-01'));
  await chmod(join(ws.DIST, 'index.html'), 0o600);
  s3.requests.length = 0;
  const complete = await run({ ...ws.env, ...s3.env, IMAGES_DIR: ws.IMAGES });
  assert.equal(complete.status, 0, complete.out);
  assert.match(complete.out, /图片：新传 1 个，已存在跳过 1 个/);
  assert.deepEqual(s3.requests.filter((r) => r.startsWith('PUT ')), [`PUT ${KEYS.webp2}`, `PUT ${versionKey}`]);
  assert.deepEqual(await readFile(ws.archive), archive, '文件 mtime 改变不影响归档字节');
  const published = s3.objects.get(versionKey);
  assert.equal(published.contentType, CONTENT_TYPE_MANIFEST);
  assert.equal(published.cacheControl, CACHE_IMMUTABLE_YEAR);
  assert.equal(JSON.parse(published.body).db.key, 'db/gallery-2026-09-03.sqlite');
  assert.equal(s3.objects.get('db/manifest.json').body.toString(), old);
  assert.ok(!existsSync(join(ws.OUT, 'manifest-previous.json')));

  const original = Buffer.from(published.body);
  await writeFile(join(ws.OUT, 'manifest.json'), JSON.stringify(manifest({ generatedAt: '2031-01-01T00:00:00Z' })));
  s3.requests.length = 0;
  const retry = await run({ ...ws.env, ...s3.env });
  assert.equal(retry.status, 0, retry.out);
  assert.equal(s3.requests.filter((r) => r.startsWith('PUT ')).length, 0);
  assert.deepEqual(s3.objects.get(versionKey).body, original, '保留初次生成时间和原文字节');
  assert.ok(s3.requests.every((r) => !r.endsWith(' db/manifest.json')), '准备发布不访问共享指针');
});

test('publish:r2：归档工具缺失，dry-run 也拒绝且不访问存储', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3();
  t.after(s3.close);
  const emptyPath = join(ws.tmp, 'empty-path');
  await mkdir(emptyPath);
  for (const dry of ['0', '1']) {
    const result = await run({ ...ws.env, ...s3.env, PATH: emptyPath, PUBLISH_DRY_RUN: dry });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /zstd 不可用/);
    assert.doesNotMatch(result.out, /PUBLISH_DRY_RUN=1：只打印计划/);
    assert.equal(s3.requests.length, 0);
    assert.ok(!existsSync(ws.archive));
  }
});

test('publish:r2：同版本不同内容拒绝，已有对象与生产指针不覆盖', { timeout: 60_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3({ [KEYS.webp]: 'webp-bytes', [KEYS.webp2]: 'webp2-bytes', 'db/manifest.json': '{"version":"previous"}' });
  t.after(s3.close);
  const first = await run({ ...ws.env, ...s3.env });
  assert.equal(first.status, 0, first.out);
  const snapshots = new Map([...s3.objects].map(([k, v]) => [k, Buffer.from(v.body)]));
  for (const [name, path, replacement, error] of [
    ['库', join(ws.OUT, 'db', 'gallery-2026-09-03.sqlite'), Buffer.alloc(8192, 1), /实际 SHA-256/],
    ['摘要', join(ws.OUT, 'db', 'gallery-2026-09-03.sqlite.chunks.json'), '{"version":2}', /分块摘要的版本/],
    ['归档', join(ws.DIST, 'index.html'), '<!doctype html><title>已改变</title>', /不可变对象.*内容不同/],
    ['版本清单', join(ws.OUT, 'manifest.json'), JSON.stringify(manifest({ series: [{ title: '已改变' }] })), /不可变对象.*内容不同/],
  ]) {
    await t.test(name, async () => {
      const original = await readFile(path);
      await writeFile(path, replacement);
      s3.requests.length = 0;
      const result = await run({ ...ws.env, ...s3.env });
      await writeFile(path, original);
      assert.equal(result.status, 1, result.out);
      assert.match(result.out, error);
      if (name === '库' || name === '摘要') assert.equal(s3.requests.length, 0, '本地完整性失败应在任何存储访问前退出');
      assert.equal(s3.requests.filter((r) => r.startsWith('PUT ')).length, 0);
      for (const [key, body] of snapshots) assert.deepEqual(s3.objects.get(key).body, body);
    });
  }
});

test('publish:r2：读取既存对象失败即停止，HEAD 失败不能当缺图', { timeout: 60_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3({ [KEYS.webp]: 'a', [KEYS.webp2]: 'b' });
  t.after(s3.close);
  s3.getStatus = 500;
  const readFailed = await run({ ...ws.env, ...s3.env });
  assert.equal(readFailed.status, 1, readFailed.out);
  assert.match(readFailed.out, /对象存储回 HTTP 500/);
  assert.equal(s3.requests.filter((r) => r.startsWith('PUT ')).length, 0);
  s3.getStatus = null;
  s3.headStatus = 500;
  const verifyFailed = await run({ ...ws.env, ...s3.env });
  assert.equal(verifyFailed.status, 1, verifyFailed.out);
  assert.match(verifyFailed.out, /对象存储回 HTTP 500/);
  assert.doesNotMatch(verifyFailed.out, /缺 img\//);
  assert.ok(!s3.objects.has('db/manifest-2026-09-03.json'));
  assert.ok(!s3.objects.has('db/manifest.json'));
});
