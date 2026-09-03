// build:db 的端到端测试：DATA_DIR 指到样本、OUT_DIR 指到临时目录，真 spawn 脚本，再让 check 守卫
// 过一遍产物。不 mock：文件名带版本、清单与文件的字节对应、manifest.json 的 db 字段、旧版本被清掉，
// 这些只有真跑出来才算数。不碰仓库根的 data/ dist/ out/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(script, env) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function headerPageSize(bytes) {
  const raw = bytes.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}

/** check 输出里 out/db 那一节是否 ✔：节标题之后、下一个 ✔/✘ 之前只有缩进的 note 行。 */
const OUT_DB_SECTION_OK = /── out\/db[^\n]*──\n(?: [^\n]*\n)*✔ 通过/;

test('build:db：样本 → gallery-<version>.sqlite + .chunks.json，manifest.json 的 db 字段更新，check 通过', { timeout: 60_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-db-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OUT = join(tmp, 'out');
  const env = { DATA_DIR: FIXTURES, DIST_DIR: join(tmp, 'dist'), OUT_DIR: OUT, RELEASE_VERSION: '2026-09-03' };
  // 模拟 build:manifest 先跑过：放一份最小 manifest.json；再放一个旧版本的库，验证 out/db 会被清空
  await mkdir(join(OUT, 'db'), { recursive: true });
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify({ version: '2026-09-03', images: ['img/x.avif'] }));
  await writeFile(join(OUT, 'db', 'gallery-old.sqlite'), 'stale');

  const r = run('build-db.mjs', env);
  assert.equal(r.status, 0, r.out);

  const dbName = 'gallery-2026-09-03.sqlite';
  const dbPath = join(OUT, 'db', dbName);
  const chunksPath = `${dbPath}.chunks.json`;
  assert.deepEqual((await readdir(join(OUT, 'db'))).sort(), [dbName, `${dbName}.chunks.json`], '只剩当前版本这一对文件');

  const bytes = await readFile(dbPath);
  assert.equal(bytes.toString('latin1', 0, 16), 'SQLite format 3\0');
  assert.equal(headerPageSize(bytes), 4096, 'site.config.yaml 的 db.page_size');
  assert.equal(bytes[18], 1);
  assert.equal(bytes[19], 1);

  const chunks = JSON.parse(await readFile(chunksPath, 'utf8'));
  assert.equal(chunks.version, 1);
  assert.equal(chunks.totalBytes, (await stat(dbPath)).size);
  assert.equal(chunks.chunkSize, 65536, 'site.config.yaml 的 db.chunk_size');
  assert.equal(chunks.sha256, sha256(bytes));
  assert.equal(chunks.chunks.length, Math.ceil(bytes.length / 65536));
  chunks.chunks.forEach((hex, i) => assert.equal(hex, sha256(bytes.subarray(i * 65536, (i + 1) * 65536)), `第 ${i} 块`));

  const manifest = JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.images, ['img/x.avif'], '其他字段原样保留');
  assert.equal(manifest.version, '2026-09-03');
  assert.deepEqual(manifest.db, {
    version: '2026-09-03',
    key: `db/${dbName}`,
    size: bytes.length,
    sha256: chunks.sha256,
    pageSize: 4096,
    chunkSize: 65536,
    chunks: `db/${dbName}.chunks.json`,
  });

  // 日志：各表行数、大小、页数、耗时、落盘前的逐页校验
  assert.match(r.out, /series 2、issues 3、chapters 4、pages 8、lines 4/);
  assert.match(r.out, new RegExp(`${bytes.length} 字节 = ${bytes.length / 4096} 页 × 4096，建库 \\d+ ms，逐页校验通过`));
  assert.match(r.out, /build:db 完成，共 \d+ ms/);

  await t.test('check 守卫对这套产物退出码 0，out/db 那一节通过', () => {
    const c = run('check.mjs', env);
    assert.match(c.out, OUT_DB_SECTION_OK, c.out);
    assert.equal(c.status, 0, c.out);
  });
});

test('0 话：空 data/ 也建出合法空库；没有 manifest.json 时提示跳过；check 通过', { timeout: 60_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-db-empty-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OUT = join(tmp, 'out');
  const env = { DATA_DIR: join(tmp, 'data'), DIST_DIR: join(tmp, 'dist'), OUT_DIR: OUT, RELEASE_VERSION: 'v0' };
  const r = run('build-db.mjs', env);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /跳过/);
  assert.match(r.out, /series 0、issues 0、chapters 0、pages 0、lines 0/);
  assert.ok(!existsSync(join(OUT, 'manifest.json')), '没有 manifest.json 就不该凭空造一个');
  const dbPath = join(OUT, 'db', 'gallery-v0.sqlite');
  const bytes = await readFile(dbPath);
  assert.ok(bytes.length > 0);
  assert.equal(headerPageSize(bytes), 4096);
  const chunks = JSON.parse(await readFile(`${dbPath}.chunks.json`, 'utf8'));
  assert.equal(chunks.totalBytes, bytes.length);
  assert.equal(chunks.sha256, sha256(bytes));
  const c = run('check.mjs', env);
  assert.match(c.out, OUT_DB_SECTION_OK, c.out);
  assert.equal(c.status, 0, c.out);
});

test('manifest.json 的版本与本次 build:db 不一致：退出码 1、提示重跑 build:manifest，out/db 与 manifest 原样不动', { timeout: 60_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-db-mismatch-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OUT = join(tmp, 'out');
  const env = { DATA_DIR: FIXTURES, DIST_DIR: join(tmp, 'dist'), OUT_DIR: OUT, RELEASE_VERSION: '2026-09-04' };
  // 模拟「build:manifest 与 build:db 跨了 UTC 零点」或「单独重跑 build:db」：manifest 还是前一个版本
  const manifestBefore = JSON.stringify({ version: '2026-09-03', images: ['img/x.avif'], db: null });
  await mkdir(join(OUT, 'db'), { recursive: true });
  await writeFile(join(OUT, 'manifest.json'), manifestBefore);
  await writeFile(join(OUT, 'db', 'gallery-2026-09-03.sqlite'), 'stale');

  const r = run('build-db.mjs', env);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /2026-09-03/);
  assert.match(r.out, /2026-09-04/);
  assert.match(r.out, /build:manifest/);
  assert.match(r.out, /RELEASE_VERSION/);
  // 对不上就什么都不写：旧库还在、没有新库、manifest 一字不改
  assert.deepEqual(await readdir(join(OUT, 'db')), ['gallery-2026-09-03.sqlite']);
  assert.equal(await readFile(join(OUT, 'manifest.json'), 'utf8'), manifestBefore);

  // 版本对上就照常写；缺省版本（UTC 日期）与 build:manifest 走的是同一个函数，这里也一并对一次
  const today = new Date().toISOString().slice(0, 10);
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify({ version: today, images: [] }));
  const again = run('build-db.mjs', { ...env, RELEASE_VERSION: '' });
  assert.equal(again.status, 0, again.out);
  assert.deepEqual((await readdir(join(OUT, 'db'))).sort(), [`gallery-${today}.sqlite`, `gallery-${today}.sqlite.chunks.json`]);
  assert.equal(JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8')).db.version, today);
});

test('RELEASE_VERSION 缺省用 UTC 日期；带路径分隔符的版本号拒收', { timeout: 60_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-db-version-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const OUT = join(tmp, 'out');
  const env = { DATA_DIR: FIXTURES, DIST_DIR: join(tmp, 'dist'), OUT_DIR: OUT, RELEASE_VERSION: '' };
  assert.equal(run('build-db.mjs', env).status, 0);
  const names = await readdir(join(OUT, 'db'));
  assert.equal(names.length, 2);
  assert.match(names.sort()[0], /^gallery-\d{4}-\d{2}-\d{2}\.sqlite$/);

  const bad = run('build-db.mjs', { ...env, RELEASE_VERSION: '../evil' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /RELEASE_VERSION/);
  assert.ok(!existsSync(join(OUT, '..', 'evil')));
});
