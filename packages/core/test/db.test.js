// 检索库构建的测试：拿测试样本真建库、真开回来、真查。库对不对没法靠读 SQL 看出来——page_size
// 有没有落到文件头、FTS 有没有 rebuild、trigram 对两字到底命不命中、繁体查询串不归一会不会漏，
// 只有把字节开回来查一遍才算数。分块清单则拿 node:crypto 独立算一遍对账，两套实现互相验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';
import { buildGalleryDb, openGalleryDb, tableCounts, TABLES } from '../src/db/build.js';
import { issueKey } from '../src/model.js';
import { computeChunkManifest, chunkCount, chunkRange, sha256Hex } from '../src/db/chunks.js';
import { buildGallery } from '../src/model.js';
import { loadGallery } from '../../../scripts/lib/data.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/data', import.meta.url));
const gallery = await loadGallery({ dataDir: FIXTURES });
const nodeSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** 文件头偏移 16–17 大端 = page_size；65536 存成 1（sqlite 文件格式的规定）。 */
const headerPageSize = (bytes) => {
  const raw = (bytes[16] << 8) | bytes[17];
  return raw === 1 ? 65536 : raw;
};
const count = (db, sql, bind) => Number(db.selectValue(sql, bind));
// selectObjects 返回的是无原型对象，deepEqual 会连原型一起比；抄成普通对象再比
const rows = (db, sql, bind) => db.selectObjects(sql, bind).map((r) => ({ ...r }));
// 检索结果 join 回坐标与话：lines → pages → chapters → issues（§4「结果带 bbox，阅读器据此高亮」）
const JOIN_SQL = `
  FROM lines_fts f
  JOIN lines l ON l.id = f.rowid
  JOIN pages p ON p.id = l.page_id
  JOIN chapters c ON c.id = p.chapter_id
  JOIN issues i ON i.id = c.issue_id`;

test('page_size 4096 / 8192 / 65536：文件头 16–17 字节是 page_size、18/19 = 1（非 WAL），开回来 PRAGMA 一致', async () => {
  for (const pageSize of [4096, 8192, 65536]) {
    const bytes = await buildGalleryDb(gallery, { pageSize });
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(String.fromCharCode(...bytes.subarray(0, 16)), 'SQLite format 3\0');
    assert.equal(headerPageSize(bytes), pageSize, `page_size=${pageSize} 的文件头`);
    assert.equal(bytes[18], 1, '写格式版本 1 = 非 WAL');
    assert.equal(bytes[19], 1, '读格式版本 1 = 非 WAL');
    assert.equal(bytes.length % pageSize, 0, '文件长度是整页');
    const db = await openGalleryDb(bytes);
    try {
      assert.equal(db.selectValue('PRAGMA page_size'), pageSize);
      // 刚建好的库本来就没有空闲页，这里只是陈述导出物的事实，证明不了 VACUUM 起了作用
      assert.equal(count(db, 'PRAGMA freelist_count'), 0, '导出物没有空闲页');
    } finally {
      db.close();
    }
  }
  assert.equal(headerPageSize(await buildGalleryDb(gallery, { pageSize: 65536 })), 65536);
});

test('page_size 不是 512–65536 之间 2 的幂时拒绝', async () => {
  await assert.rejects(buildGalleryDb(gallery, { pageSize: 3000 }), RangeError);
  await assert.rejects(buildGalleryDb(gallery, { pageSize: undefined }), RangeError);
});

test('各表行数与模型 totals 对得上；tn 为空的框不入 lines；外键 join 一个不丢', async () => {
  const bytes = await buildGalleryDb(gallery, { pageSize: 4096 });
  const db = await openGalleryDb(bytes);
  try {
    const t = gallery.totals;
    const linesExpected = gallery.chapters.reduce((n, c) => n + c.pages.reduce((m, p) => m + p.boxes.filter((b) => b.tn).length, 0), 0);
    assert.equal(linesExpected, t.boxes - 1, '样本里恰好一个 tn 为空的框（c001 第 2 页的「……」）');
    assert.deepEqual(tableCounts(db), { series: t.series, issues: t.issues, chapters: t.chapters, pages: t.pages, lines: linesExpected });
    assert.deepEqual(TABLES, ['series', 'issues', 'chapters', 'pages', 'lines']);
    assert.equal(count(db, "SELECT count(*) FROM lines WHERE text_norm = ''"), 0);
    assert.equal(count(db, 'SELECT count(*) FROM lines_fts'), linesExpected, 'FTS 已 rebuild，行数与 lines 一致');

    // id 形式：issues 是 <series>/<issue>，chapters 是 <series>/<issue>/<chapter>
    assert.equal(issueKey('sample', 'vol01'), 'sample/vol01');
    assert.deepEqual(db.selectValues('SELECT id FROM issues ORDER BY id'), ['sample/vol01', 'sample/vol02', 'zeta/v1']);
    assert.deepEqual(db.selectValues('SELECT id FROM chapters ORDER BY id'), ['sample/vol01/c001', 'sample/vol01/c002', 'sample/vol02/c003', 'zeta/v1/ch1']);
    // 外键列 join 得回去
    assert.equal(count(db, 'SELECT count(*) FROM issues i JOIN series s ON s.id = i.series_id'), t.issues);
    assert.equal(count(db, 'SELECT count(*) FROM chapters c JOIN issues i ON i.id = c.issue_id'), t.chapters);
    assert.equal(count(db, 'SELECT count(*) FROM pages p JOIN chapters c ON c.id = p.chapter_id'), t.pages);
    assert.equal(count(db, 'SELECT count(*) FROM lines l JOIN pages p ON p.id = l.page_id'), linesExpected);
    // 字段：published 可空、number 是 REAL、pages 的 n/img/w/h、chapters.url
    assert.equal(db.selectValue("SELECT published FROM issues WHERE id = 'sample/vol01'"), '2026-01-01');
    assert.equal(db.selectValue("SELECT published FROM issues WHERE id = 'zeta/v1'"), null);
    assert.deepEqual(rows(db, "SELECT number, title, url FROM chapters WHERE id = 'sample/vol02/c003'"), [{ number: 3, title: '第三话 余烬', url: '/sample/vol02/c003/' }]);
    assert.deepEqual(rows(db, "SELECT n, img, w, h FROM pages WHERE chapter_id = 'sample/vol01/c001' ORDER BY n"), [
      { n: 1, img: '0123456789ab', w: 1200, h: 1700 },
      { n: 2, img: '123456789abc', w: 1200, h: 1700 },
      { n: 3, img: '23456789abcd', w: 2400, h: 1700 },
    ]);
    assert.deepEqual(rows(db, "SELECT ord, x, y, w, h, text, text_norm FROM lines WHERE text = '漫画作者的契約'"), [
      { ord: 1, x: 0.55, y: 0.4, w: 0.3, h: 0.1, text: '漫画作者的契約', text_norm: '漫画作者的契约' },
    ]);
    // 索引都在（建库末尾一次性建）
    const indexes = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name");
    assert.deepEqual(indexes, ['chapters_issue_id', 'issues_series_id', 'lines_page_id', 'pages_chapter_n']);
  } finally {
    db.close();
  }
});

test("lines_fts MATCH '漫画作者' 命中，能 join 回 x/y/w/h、页码与 chapters.url；按作品过滤也走同一条 join", async () => {
  const db = await openGalleryDb(await buildGalleryDb(gallery, { pageSize: 4096 }));
  try {
    const sql = `SELECT l.x, l.y, l.w, l.h, l.ord, l.text, p.n, c.url, c.id AS chapter, i.series_id ${JOIN_SQL} WHERE lines_fts MATCH ?`;
    assert.deepEqual(rows(db, sql, ['漫画作者']), [
      { x: 0.55, y: 0.4, w: 0.3, h: 0.1, ord: 1, text: '漫画作者的契約', n: 1, url: '/sample/vol01/c001/', chapter: 'sample/vol01/c001', series_id: 'sample' },
    ]);
    // 子串级：跨词边界的片段也命中
    assert.equal(count(db, `SELECT count(*) ${JOIN_SQL} WHERE lines_fts MATCH ?`, ['者的契']), 1);
    assert.equal(count(db, `SELECT count(*) ${JOIN_SQL} WHERE lines_fts MATCH ? AND i.series_id = 'sample'`, ['漫画作者']), 1);
    assert.equal(count(db, `SELECT count(*) ${JOIN_SQL} WHERE lines_fts MATCH ? AND i.series_id = 'zeta'`, ['漫画作者']), 0);
    assert.equal(count(db, `SELECT count(*) ${JOIN_SQL} WHERE lines_fts MATCH ?`, ['不存在的台词']), 0);
  } finally {
    db.close();
  }
});

test('trigram：恰好 2 字 MATCH 不命中，LIKE 命中；LIKE 先按作品 / 期过滤', async () => {
  const db = await openGalleryDb(await buildGalleryDb(gallery, { pageSize: 4096 }));
  try {
    assert.equal(count(db, "SELECT count(*) FROM lines_fts WHERE lines_fts MATCH '漫画'"), 0);
    assert.equal(count(db, "SELECT count(*) FROM lines WHERE text_norm LIKE '%漫画%'"), 1);
    assert.equal(count(db, "SELECT count(*) FROM lines_fts WHERE lines_fts MATCH '再见'"), 0);
    assert.equal(count(db, "SELECT count(*) FROM lines WHERE text_norm LIKE '%再见%'"), 1);
    const likeIn = `SELECT count(*) FROM lines l JOIN pages p ON p.id = l.page_id JOIN chapters c ON c.id = p.chapter_id JOIN issues i ON i.id = c.issue_id
      WHERE l.text_norm LIKE ? AND i.series_id = ?`;
    assert.equal(count(db, likeIn, ['%再见%', 'zeta']), 1);
    assert.equal(count(db, likeIn, ['%再见%', 'sample']), 0);
    const likeInIssue = likeIn.replace('i.series_id = ?', 'i.id = ?');
    assert.equal(count(db, likeInIssue, ['%绝望%', 'sample/vol01']), 1);
    assert.equal(count(db, likeInIssue, ['%绝望%', 'sample/vol02']), 0);
  } finally {
    db.close();
  }
});

test('繁体查询串：原样查不到（库里 tn 是简体），归一成简体后命中', async () => {
  const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' });
  const db = await openGalleryDb(await buildGalleryDb(gallery, { pageSize: 4096 }));
  try {
    for (const [traditional, expectedHits] of [
      ['的契約', 1],
      ['希望与絕望', 1],
    ]) {
      const simplified = toSimplified(traditional);
      assert.notEqual(simplified, traditional, `${traditional} 应有繁→简变化`);
      assert.equal(count(db, 'SELECT count(*) FROM lines_fts WHERE lines_fts MATCH ?', [traditional]), 0, `${traditional} 原样不命中`);
      assert.equal(count(db, 'SELECT count(*) FROM lines_fts WHERE lines_fts MATCH ?', [simplified]), expectedHits, `${simplified} 命中`);
    }
  } finally {
    db.close();
  }
});

test('0 话：空模型也建出合法的库，开回来查不报错', async () => {
  const bytes = await buildGalleryDb(buildGallery([]), { pageSize: 4096 });
  assert.equal(headerPageSize(bytes), 4096);
  assert.equal(bytes[18], 1);
  assert.equal(bytes[19], 1);
  const db = await openGalleryDb(bytes);
  try {
    assert.deepEqual(tableCounts(db), { series: 0, issues: 0, chapters: 0, pages: 0, lines: 0 });
    assert.deepEqual(rows(db, `SELECT l.x ${JOIN_SQL} WHERE lines_fts MATCH '漫画作者'`), []);
    assert.equal(count(db, "SELECT count(*) FROM lines WHERE text_norm LIKE '%漫画%'"), 0);
  } finally {
    db.close();
  }
});

test('openGalleryDb：接受 Node Buffer；不是 sqlite 文件的字节在打开时就报错', async () => {
  const bytes = await buildGalleryDb(gallery, { pageSize: 4096 });
  // 构建脚本从磁盘读回来的是 Buffer（可能是共享池里带 byteOffset 的一段）。这里造一个 byteOffset
  // 一定不为 0 的：超过 4 KiB 的 concat 走非池化分配（byteOffset 0），subarray(4) 之后就是 4
  const pooled = Buffer.concat([Buffer.from('xxxx'), Buffer.from(bytes)]).subarray(4);
  assert.equal(pooled.byteOffset, 4);
  assert.equal(pooled.length, bytes.length);
  const db = await openGalleryDb(pooled);
  try {
    assert.equal(tableCounts(db).lines, 4);
  } finally {
    db.close();
  }
  await assert.rejects(openGalleryDb(new Uint8Array(4096).fill(7)), /NOTADB|not a database/);
  await assert.rejects(openGalleryDb('not bytes'), TypeError);
});

test('openGalleryDb 的 verify：截断的文件打开即报；中间坏页不带 verify 能开、带 verify 拒绝；好文件两种都过', async () => {
  const bytes = await buildGalleryDb(gallery, { pageSize: 4096 });
  assert.ok(bytes.length / 4096 >= 12, `样本库 ${bytes.length / 4096} 页，够挑一页出来弄坏`);
  // 只留前 3 页：文件头记的页数与实际长度对不上，碰 sqlite_master 就报
  await assert.rejects(openGalleryDb(bytes.subarray(0, 4096 * 3)), /CORRUPT|malformed/);
  // 第 1 页完好、把中间一页清零：不 verify 时 sqlite_master 读得到、能开；verify 走到那页就报
  const corrupt = new Uint8Array(bytes);
  corrupt.fill(0, 4096 * 8, 4096 * 9);
  const db = await openGalleryDb(corrupt);
  db.close();
  await assert.rejects(openGalleryDb(corrupt, { verify: true }), /CORRUPT|malformed|quick_check/);
  const good = await openGalleryDb(bytes, { verify: true });
  try {
    assert.equal(tableCounts(good).lines, 4);
  } finally {
    good.close();
  }
});

test('chunks manifest：块数 = ceil(total/chunkSize)、最后一块可短，逐块与整份 sha256 与 node:crypto 一致', async () => {
  const bytes = await buildGalleryDb(gallery, { pageSize: 4096 });
  assert.ok(bytes.length > 10000, `样本库 ${bytes.length} 字节，够切出多块`);
  // 65536 = 配置里的块大小；4096 = 一页一块；10000 不整除，最后一块必短
  for (const chunkSize of [65536, 4096, 10000]) {
    const m = await computeChunkManifest(bytes, chunkSize);
    assert.equal(m.version, 1);
    assert.equal(m.totalBytes, bytes.length);
    assert.equal(m.chunkSize, chunkSize);
    assert.equal(m.chunks.length, Math.ceil(bytes.length / chunkSize));
    assert.equal(m.chunks.length, chunkCount(bytes.length, chunkSize));
    assert.equal(m.sha256, nodeSha256(bytes));
    m.chunks.forEach((hex, i) => {
      const { start, end, length } = chunkRange(i, chunkSize, bytes.length);
      assert.equal(length, end - start + 1);
      assert.equal(hex, nodeSha256(bytes.subarray(start, end + 1)), `第 ${i} 块（${start}–${end}）`);
      assert.match(hex, /^[0-9a-f]{64}$/);
    });
    const last = chunkRange(m.chunks.length - 1, chunkSize, bytes.length);
    assert.equal(last.end, bytes.length - 1, '最后一块到文件尾');
    assert.equal(last.length, bytes.length - (m.chunks.length - 1) * chunkSize);
    if (bytes.length % chunkSize) assert.ok(last.length < chunkSize, '不整除时最后一块短');
  }
  // Buffer 与 ArrayBuffer 输入算出同样的结果
  assert.equal((await computeChunkManifest(Buffer.from(bytes), 65536)).sha256, nodeSha256(bytes));
  assert.equal(await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), nodeSha256(bytes));
  assert.equal(await sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('chunkCount / chunkRange 的边界：0 字节 0 块、整除不多一块、越界与非法参数抛 RangeError', async () => {
  assert.equal(chunkCount(0, 65536), 0);
  assert.equal(chunkCount(1, 65536), 1);
  assert.equal(chunkCount(65536, 65536), 1);
  assert.equal(chunkCount(65537, 65536), 2);
  assert.deepEqual(chunkRange(0, 65536, 100000), { start: 0, end: 65535, length: 65536 });
  assert.deepEqual(chunkRange(1, 65536, 100000), { start: 65536, end: 99999, length: 34464 });
  assert.deepEqual(chunkRange(0, 65536, 65536), { start: 0, end: 65535, length: 65536 });
  assert.throws(() => chunkRange(2, 65536, 100000), RangeError);
  assert.throws(() => chunkRange(-1, 65536, 100000), RangeError);
  assert.throws(() => chunkRange(0, 65536, 0), RangeError);
  assert.throws(() => chunkRange(0.5, 65536, 100000), RangeError);
  assert.throws(() => chunkCount(10, 0), RangeError);
  assert.throws(() => chunkCount(10, -1), RangeError);
  assert.throws(() => chunkCount(-1, 10), RangeError);
  const empty = await computeChunkManifest(new Uint8Array(0), 65536);
  assert.deepEqual(empty, { version: 1, totalBytes: 0, chunkSize: 65536, sha256: await sha256Hex(new Uint8Array(0)), chunks: [] });
});
