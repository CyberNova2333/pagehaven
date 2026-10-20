// status 脚本的端到端测试：构造 out/manifest.json 与假 dist，真 spawn 脚本，STATUS_FILE 指到临时目录——
// 仓库根的 STATUS.md 只由发布流水线写（铁律 10），测试前后比对它一字未动。
//
// 对象存储那条路对着本地假 S3（只答 ListObjectsV2）跑真 SDK；渲染函数另有纯单测。
// db / 图片前缀的期望值从仓库的 site.config.yaml 读（脚本经 loadSiteConfig 读固定路径，指不到
// 临时配置）：维护者改前缀或域名时，这些与改动无关的断言不该跟着红。
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
import { renderStatus, formatBytes, formatDuration } from '../lib/status.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'write-status.mjs');
const REPO_STATUS = join(ROOT, 'STATUS.md');
const CREDS = {
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'sk',
  R2_BUCKET: 'test-bucket',
};
const CONFIG = await loadSiteConfig();
const DB = CONFIG.db.prefix;
const IMG = CONFIG.images.prefix;
const DB_KEY = `${DB}gallery-2026-09-03.sqlite`;

function manifest(overrides = {}) {
  return {
    version: '2026-09-03',
    generatedAt: '2026-09-03T04:00:00.000Z',
    site: { domain: CONFIG.site.domain },
    images: { hosts: CONFIG.images.hosts, prefix: IMG },
    totals: { series: 2, issues: 3, chapters: 4, pages: 8, boxes: 5 },
    series: [],
    imageKeys: [],
    db: {
      version: '2026-09-03',
      key: DB_KEY,
      size: 1234567,
      sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      pageSize: 4096,
      chunkSize: 65536,
      chunks: `${DB_KEY}.chunks.json`,
    },
    ...overrides,
  };
}

/** 干净的环境：去掉本机 / CI 里可能存在的凭据、版本与运行标识，行为只由测试给的决定。 */
function cleanEnv() {
  const env = { ...process.env };
  const drop = /^(R2_|RELEASE_|GITHUB_|DEPLOY_TARGET$|STATUS_FILE$|DATA_DIR$|DIST_DIR$|OUT_DIR$)/;
  for (const k of Object.keys(env)) if (drop.test(k)) delete env[k];
  return env;
}

/**
 * 异步 spawn 而不是 spawnSync：假 S3 就住在这个测试进程里，spawnSync 会把事件循环卡住，
 * 服务器答不了话、子进程等回应——死锁。
 */
function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
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

/** 一个临时工作区：out/manifest.json、dist/ 里 files 个文件（有嵌套）、STATUS.md 的目标路径。 */
async function workspace(t, { manifestJson = manifest(), distFiles = 3 } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-status-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OUT = join(tmp, 'out');
  const DIST = join(tmp, 'dist');
  await mkdir(OUT, { recursive: true });
  if (manifestJson) await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifestJson, null, 2) + '\n');
  if (distFiles != null) {
    await mkdir(join(DIST, 'a', 'b'), { recursive: true });
    for (let i = 0; i < distFiles; i += 1) {
      await writeFile(join(DIST, i % 2 ? 'a' : join('a', 'b'), `f${i}.html`), '<!doctype html>');
    }
  }
  const STATUS = join(tmp, 'status', 'STATUS.md');
  return { tmp, env: { OUT_DIR: OUT, DIST_DIR: DIST, STATUS_FILE: STATUS }, STATUS };
}

/**
 * 本地假 S3：只实现 ListObjectsV2；objects 是 key → 大小。
 * deny 为真时对一切请求回 403（鉴权失败那条路），错误信息里故意塞进桶名、账号与端点主机，
 * 验脚本写 STATUS.md 前真把它们抹掉了。
 */
async function fakeS3(objects, { deny = false } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (deny) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code>' +
          `<Message>Access Denied to ${CREDS.R2_BUCKET} for ${CREDS.R2_ACCOUNT_ID} at 127.0.0.1</Message></Error>`,
      );
      return;
    }
    const isList =
      req.method === 'GET' && url.pathname === `/${CREDS.R2_BUCKET}/` && url.searchParams.get('list-type') === '2';
    if (!isList) {
      res.writeHead(404);
      res.end();
      return;
    }
    const prefix = url.searchParams.get('prefix') ?? '';
    const keys = Object.keys(objects).filter((k) => k.startsWith(prefix)).sort();
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      `<Name>${CREDS.R2_BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount>` +
      '<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>' +
      keys.map((k) => `<Contents><Key>${k}</Key><Size>${objects[k]}</Size><ETag>"e"</ETag></Contents>`).join('') +
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

const HEADER = [
  '# STATUS.md — 当前状态',
  '',
  '> 本文件由 `.cnb.yml` 的发布流水线在每次发布末尾自动写入（CLAUDE.md 铁律 10），**不手改**。',
  '> 它是弃维护后别人接手的入口：从这里能知道线上是哪个版本、部署在哪、数据在哪。',
  '',
  '| 项 | 值 |',
  '|---|---|',
].join('\n');

const ROW_NAMES = [
  '版本',
  '当前部署目标',
  '站点域名',
  '检索库',
  'dist 文件数',
  '对象存储对象清单',
  '最近一次发布耗时',
  '写入时间（UTC）',
  '发布运行',
];

/** 铁律 7：账号 ID、桶名、密钥、端点都不许出现在 STATUS.md 里。 */
const SECRETS = [CREDS.R2_ACCOUNT_ID, CREDS.R2_BUCKET, CREDS.R2_ACCESS_KEY_ID, CREDS.R2_SECRET_ACCESS_KEY, '127.0.0.1'];
function assertNoSecrets(md) {
  for (const s of SECRETS) assert.ok(!md.includes(s), `STATUS.md 不该出现 ${s}`);
}

/** 表格解析：行名 → 值（跳过两张表的表头行）。 */
function rows(md) {
  const out = new Map();
  for (const m of md.matchAll(/^\| ([^|]+?) \| (.*) \|$/gm)) if (!['项', 'key'].includes(m[1])) out.set(m[1], m[2]);
  return out;
}

test('status：读 manifest + 环境 + dist，写 STATUS_FILE；无凭据时对象清单写「—」；仓库根 STATUS.md 不动', { timeout: 30_000 }, async (t) => {
  const repoStatusBefore = await readFile(REPO_STATUS, 'utf8');
  const ws = await workspace(t);
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  const r = await run({
    ...ws.env,
    RELEASE_VERSION: '2026-09-03',
    DEPLOY_TARGET: 'github',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'someone/repo',
    GITHUB_RUN_ID: '123456',
    RELEASE_STARTED_AT: startedAt,
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /没有对象存储凭据/);
  assert.equal(await readFile(REPO_STATUS, 'utf8'), repoStatusBefore, '仓库根 STATUS.md 只由发布流水线写');

  const md = await readFile(ws.STATUS, 'utf8');
  assert.ok(md.startsWith(HEADER + '\n'), '顶部那段「不手改」与表头原样保留');
  const table = rows(md);
  assert.deepEqual([...table.keys()], ROW_NAMES, '行固定、顺序固定');
  assert.equal(table.get('版本'), '2026-09-03');
  assert.equal(table.get('当前部署目标'), 'github');
  assert.ok(table.get('站点域名').includes(`\`${CONFIG.site.domain}\``), table.get('站点域名'));
  assert.equal(table.get('检索库'), `\`${DB_KEY}\`（1 234 567 字节，sha256 \`abcdef012345…\`）`);
  assert.equal(table.get('dist 文件数'), '3');
  assert.equal(table.get('对象存储对象清单'), '—（无对象存储凭据，未列出）');
  assert.match(table.get('最近一次发布耗时'), /^1 分 3\d 秒$/);
  assert.match(table.get('写入时间（UTC）'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
  assert.equal(table.get('发布运行'), '[123456](https://github.com/someone/repo/actions/runs/123456)');
  assert.ok(md.endsWith('重建步骤见 [README.md](README.md)「十分钟重建」。\n'));
  assert.ok(!md.includes('## 对象存储里的检索库'), '没列清单就没有清单节');
});

test('status：dist 不存在、db 为 null、不在 CI 里、没给版本 → 各写「—」/「尚未构建」，版本取 manifest', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t, { manifestJson: manifest({ db: null }), distFiles: null });
  // 缺 GITHUB_RUN_ID：三件套不齐
  const r = await run({ ...ws.env, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'someone/repo' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /尚未构建/);
  const table = rows(await readFile(ws.STATUS, 'utf8'));
  assert.equal(table.get('版本'), '2026-09-03');
  assert.equal(table.get('当前部署目标'), '—');
  assert.equal(table.get('检索库'), '（尚未构建）');
  assert.equal(table.get('dist 文件数'), '—');
  assert.equal(table.get('最近一次发布耗时'), '—');
  assert.equal(table.get('发布运行'), '—', '三件套缺一个就不拼链接');
});

test('status：没有 manifest.json 就报错退出，不写文件（status 只在发布末尾跑）', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t, { manifestJson: null });
  const r = await run({ ...ws.env, RELEASE_VERSION: '2026-09-03', DEPLOY_TARGET: 'github' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /manifest\.json/);
  await assert.rejects(readFile(ws.STATUS), { code: 'ENOENT' });
});

test('status：有凭据时对着本地假 S3 列出 db 清单与图片对象数；当前库标出；账号与桶名不出现在文件里', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t, { distFiles: 5 });
  const s3 = await fakeS3({
    [`${DB}gallery-2026-08-01.sqlite`]: 1000,
    [`${DB}gallery-2026-08-01.sqlite.chunks.json`]: 200,
    [DB_KEY]: 1234567,
    [`${DB_KEY}.chunks.json`]: 4321,
    [`${IMG}sample/vol01/c001/1-0123456789ab.avif`]: 10,
    [`${IMG}sample/vol01/c001/1-0123456789ab.webp`]: 11,
    [`${IMG}zeta/v1/ch1/1-6789abcdef01.avif`]: 12,
    'other/ignored': 1,
  });
  try {
    const r = await run({ ...ws.env, RELEASE_VERSION: '2026-09-03', DEPLOY_TARGET: 'all', ...s3.env });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes(`${DB} 下 4 个对象，${IMG} 下 3 个对象`), r.out);
    const listed = (p) => s3.requests.some((q) => q.includes(`prefix=${encodeURIComponent(p)}`));
    assert.ok(listed(DB) && listed(IMG), s3.requests.join('\n'));

    const md = await readFile(ws.STATUS, 'utf8');
    const table = rows(md);
    assert.equal(table.get('当前部署目标'), 'all');
    assert.equal(table.get('dist 文件数'), '5');
    assert.equal(table.get('对象存储对象清单'), `\`${DB}\` 下 4 个对象（清单见下）；图片对象 3 个`);
    assert.ok(md.includes('## 对象存储里的检索库'));
    assert.equal(table.get(`\`${DB_KEY}\``), '1 234 567 字节 | 当前', '当前库标出');
    assert.equal(table.get(`\`${DB_KEY}.chunks.json\``), '4 321 字节 | 当前');
    assert.equal(table.get(`\`${DB}gallery-2026-08-01.sqlite\``), '1 000 字节 | ', '旧版本不标');
    assert.ok(!md.includes('other/ignored'));
    assertNoSecrets(md);
  } finally {
    await s3.close();
  }
});

test('status：manifest 指向的库不在存储里时警告但照写（发布流程的其他步骤自己会失败）', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3({ [`${DB}gallery-2026-08-01.sqlite`]: 1000 });
  try {
    const r = await run({ ...ws.env, RELEASE_VERSION: '2026-09-03', ...s3.env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /不在对象存储里/);
    const table = rows(await readFile(ws.STATUS, 'utf8'));
    assert.equal(table.get(`\`${DB}gallery-2026-08-01.sqlite\``), '1 000 字节 | ');
  } finally {
    await s3.close();
  }
});

test('status：有凭据但列举失败（403）→ STATUS.md 照写并记「列出失败」、退出非零；账号 / 桶名 / 端点已抹掉', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t);
  const s3 = await fakeS3({}, { deny: true });
  try {
    const r = await run({ ...ws.env, RELEASE_VERSION: '2026-09-03', DEPLOY_TARGET: 'github', ...s3.env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /对象存储列举失败：AccessDenied HTTP 403/);
    assert.match(r.out, /STATUS\.md 已写/);
    assert.ok(s3.requests.length >= 1, '真的请求过存储');

    assert.ok(existsSync(ws.STATUS), '文件先写，再报错');
    const md = await readFile(ws.STATUS, 'utf8');
    const table = rows(md);
    assert.deepEqual([...table.keys()], ROW_NAMES, '表格形状不变');
    assert.equal(table.get('版本'), '2026-09-03');
    assert.equal(table.get('当前部署目标'), 'github');
    assert.match(table.get('对象存储对象清单'), /^列出失败：AccessDenied HTTP 403：Access Denied to … for … at …$/);
    assert.ok(!md.includes('## 对象存储里的检索库'), '没列出来就没有清单节');
    assertNoSecrets(md);
  } finally {
    await s3.close();
  }
});

test('renderStatus：纯渲染的各分支——空清单、列举失败、竖线转义、格式化', () => {
  const base = {
    version: 'v1',
    target: 'none',
    domain: 'g.example.org',
    writtenAt: '2026-09-03T05:06:07.890Z',
    runUrl: null,
    distFiles: 0,
    db: null,
    storage: null,
    durationMs: null,
  };
  const md = renderStatus(base);
  assert.ok(md.startsWith(HEADER + '\n'));
  assert.deepEqual([...rows(md).keys()], ROW_NAMES);
  assert.equal(rows(md).get('dist 文件数'), '0', '0 与「不存在」区分');
  assert.equal(rows(md).get('写入时间（UTC）'), '2026-09-03 05:06:07Z');

  const withEmpty = renderStatus({ ...base, storage: { dbPrefix: 'db/', dbObjects: [], imageObjects: 0 } });
  assert.ok(withEmpty.includes('| — | — | |'), '清单节存在但为空');
  assert.equal(rows(withEmpty).get('对象存储对象清单'), '`db/` 下 0 个对象（清单见下）；图片对象 0 个');

  const failed = renderStatus({ ...base, storageError: 'AccessDenied HTTP 403：Access Denied' });
  assert.equal(rows(failed).get('对象存储对象清单'), '列出失败：AccessDenied HTTP 403：Access Denied');
  assert.ok(!failed.includes('## 对象存储里的检索库'));
  assert.deepEqual([...rows(failed).keys()], ROW_NAMES);

  const piped = renderStatus({ ...base, target: 'a|b' });
  assert.ok(piped.includes('| 当前部署目标 | a\\|b |'), '值里的竖线不破坏表格');

  assert.equal(formatBytes(0), '0 字节');
  assert.equal(formatBytes(999), '999 字节');
  assert.equal(formatBytes(1000), '1 000 字节');
  assert.equal(formatBytes(123456789), '123 456 789 字节');
  assert.equal(formatDuration(59_400), '59 秒');
  assert.equal(formatDuration(60_000), '1 分 0 秒');
  assert.equal(formatDuration(3_725_000), '62 分 5 秒');
});

test('status：DIST_FILES 环境变量优先于自己数 dist（发布流水线的 STATUS 步骤不下载 dist）', { timeout: 30_000 }, async (t) => {
  const ws = await workspace(t, { distFiles: null });
  const r = await run({ ...ws.env, DIST_FILES: '18000' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /来自 DIST_FILES/);
  assert.equal(rows(await readFile(ws.STATUS, 'utf8')).get('dist 文件数'), '18000');
  // 不是纯数字就当没给：退回自己数（dist 不存在 → 「—」），而不是把垃圾写进 STATUS.md
  const r2 = await run({ ...ws.env, DIST_FILES: 'abc' });
  assert.equal(r2.status, 0, r2.out);
  assert.equal(rows(await readFile(ws.STATUS, 'utf8')).get('dist 文件数'), '—');
});

