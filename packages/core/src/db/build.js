// 台词检索库的构建与打开（ARCHITECTURE §4 gallery.sqlite）。
//
// 为什么放在 core 而不是 scripts：建库只依赖内存模型（Gallery）与 wasm 版 sqlite，没有一行文件
// 系统或 Node 的东西；产出是一段 Uint8Array，落盘、上传、分块摘要都是调用方的事。这样同一份代码
// 在构建期（scripts/build-db.mjs）、测试（建一份、开回来、真查一遍）与将来的函数版检索（把库载进
// 内存直接查）里都能用，且铁律 1 不被破：wasm 是 Web 标准。
//
// 库的形状是给浏览器端按 Range 分块读设计的，每条都对应检索端的一个假设：
//   · page_size 必须等于检索端 requestChunkSize（铁律 4），所以它是本模块唯一的参数，且必须是
//     连接上的第一条语句——建表之后再设不会立刻生效，容易被语句顺序悄悄绕过；
//   · 非 WAL（文件头第 18/19 字节 = 1）：WAL 库要有 -wal/-shm 伴随文件，只读的 HTTP VFS 打不开；
//   · 收尾 VACUUM：保证导出物没有空闲页、页面按表紧排，字节数尽量小、块数尽量少（刚建好的库
//     通常本来就没有空闲页，这一步是兜底，不是省了它就会多出很多页）；
//   · issues.id / chapters.id 用模型里的 key 形式（<series>/<issue>、<series>/<issue>/<chapter>）
//     保证全局唯一，另存 series_id / issue_id 外键列，§4「恰好 2 字走 LIKE 时先按作品/期过滤」
//     就是靠这两列 join 上去的。
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { issueKey } from '../model.js';
import { asUint8 } from './bytes.js';

/** @type {Promise<import('@sqlite.org/sqlite-wasm').Sqlite3Static> | null} */
let sqlite3Promise = null;

/**
 * 初始化 wasm 模块，整个进程只做一次，之后的调用共用同一个 promise。
 * print / printErr 置空：模块启动会往 stdout/stderr 打横幅，在构建日志与测试输出里都是噪音。
 * 初始化失败则把缓存清掉，下一次调用能重试，而不是永远拿到同一个已拒绝的 promise。
 */
export function initSqlite() {
  if (!sqlite3Promise) {
    sqlite3Promise = sqlite3InitModule({ print() {}, printErr() {} }).catch((e) => {
      sqlite3Promise = null;
      throw e;
    });
  }
  return sqlite3Promise;
}

/** sqlite 允许的 page_size；与 site.config.yaml 的 db.page_size 约束同一张表。 */
const PAGE_SIZES = new Set([512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]);

/** 表结构（ARCHITECTURE §4）。lines_fts 是外部内容表：正文只在 lines 里存一份，FTS 只存 trigram 索引。 */
export const SCHEMA_SQL = `
CREATE TABLE series  (id TEXT PRIMARY KEY, title TEXT, sort INTEGER);
CREATE TABLE issues  (id TEXT PRIMARY KEY, series_id TEXT, number REAL, title TEXT, published TEXT);
CREATE TABLE chapters(id TEXT PRIMARY KEY, issue_id TEXT, number REAL, title TEXT, url TEXT);
CREATE TABLE pages   (id INTEGER PRIMARY KEY, chapter_id TEXT, n INTEGER, img TEXT, w INTEGER, h INTEGER);
CREATE TABLE lines   (id INTEGER PRIMARY KEY, page_id INTEGER, ord INTEGER,
                      x REAL, y REAL, w REAL, h REAL, text TEXT, text_norm TEXT);
CREATE VIRTUAL TABLE lines_fts USING fts5(text_norm, content='lines', content_rowid='id', tokenize='trigram');
`;

// 索引在灌完数据之后再建：边插边维护 B 树比最后一次性建慢得多，而且建库是一次性的批处理。
// 四条索引对应检索结果 join 回来的四步：lines → pages → chapters → issues。
const INDEX_SQL = `
CREATE INDEX lines_page_id ON lines(page_id);
CREATE INDEX pages_chapter_n ON pages(chapter_id, n);
CREATE INDEX chapters_issue_id ON chapters(issue_id);
CREATE INDEX issues_series_id ON issues(series_id);
`;

/** 库里的实体表，按依赖顺序（不含 FTS 虚表）。 */
export const TABLES = ['series', 'issues', 'chapters', 'pages', 'lines'];

/**
 * 由内存模型建出一份完整的检索库，返回可直接落盘 / 上传的 sqlite 文件字节。
 * 0 话时也建出合法的空库：检索页对着空库正常回「无结果」，比「文件不存在」对前端友好。
 *
 * @param {import('../model.js').Gallery} gallery
 * @param {{pageSize: number}} opts  pageSize 必须等于检索端的 requestChunkSize（铁律 4）
 * @returns {Promise<Uint8Array>}
 */
export async function buildGalleryDb(gallery, { pageSize }) {
  if (!PAGE_SIZES.has(pageSize)) {
    throw new RangeError(`page_size 必须是 512–65536 之间的 2 的幂，收到 ${pageSize}`);
  }
  const sqlite3 = await initSqlite();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    // 必须是第一条语句：page_size 只在库还没分配任何页时能定下来
    db.exec(`PRAGMA page_size=${pageSize}`);
    db.exec(SCHEMA_SQL);
    // 一个事务灌完：每条 INSERT 各自提交的话，几万行台词要写几万次日志
    db.transaction(() => insertGallery(db, gallery));
    // 外部内容表不会自动跟着 lines 走，灌完必须显式 rebuild，否则 MATCH 永远空
    db.exec("INSERT INTO lines_fts(lines_fts) VALUES('rebuild')");
    db.exec(INDEX_SQL);
    // 内存库会回答 memory 而不是 delete——无妨，导出的文件头本来就是非 WAL 的；这条是给
    // 「将来换成文件库」时兜底，保证导出物永远不是 WAL。
    db.exec('PRAGMA journal_mode=DELETE');
    db.exec('VACUUM');
    return sqlite3.capi.sqlite3_js_db_export(db.pointer);
  } finally {
    db.close();
  }
}

/**
 * 按 series → issues → chapters → pages → lines 的顺序灌入。
 * pages.id / lines.id 由这里顺序分配而不是交给 sqlite 自增：外层要拿 page_id 给 lines 用，
 * 自己数比每插一行再查一次 last_insert_rowid 省一趟，也让同一份输入建出的 id 稳定。
 *
 * @param {import('@sqlite.org/sqlite-wasm').Database} db
 * @param {import('../model.js').Gallery} gallery
 */
function insertGallery(db, gallery) {
  const stmts = {
    series: db.prepare('INSERT INTO series(id, title, sort) VALUES (?, ?, ?)'),
    issues: db.prepare('INSERT INTO issues(id, series_id, number, title, published) VALUES (?, ?, ?, ?, ?)'),
    chapters: db.prepare('INSERT INTO chapters(id, issue_id, number, title, url) VALUES (?, ?, ?, ?, ?)'),
    pages: db.prepare('INSERT INTO pages(id, chapter_id, n, img, w, h) VALUES (?, ?, ?, ?, ?, ?)'),
    lines: db.prepare('INSERT INTO lines(id, page_id, ord, x, y, w, h, text, text_norm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  };
  try {
    let pageId = 0;
    let lineId = 0;
    for (const s of gallery.series) {
      stmts.series.bind([s.id, s.title, s.sort]).stepReset();
      for (const iss of s.issues) {
        const issueId = issueKey(s.id, iss.id);
        stmts.issues.bind([issueId, s.id, iss.number, iss.title, iss.published ?? null]).stepReset();
        for (const ch of iss.chapters) {
          stmts.chapters.bind([ch.key, issueId, ch.number, ch.title, ch.url]).stepReset();
          for (const p of ch.pages) {
            pageId += 1;
            stmts.pages.bind([pageId, ch.key, p.n, p.img, p.w, p.h]).stepReset();
            for (const b of p.boxes) {
              // 归一化后为空的框（省略号、纯标点）没有可检索的内容；进了库只会让 LIKE 多扫一行
              if (!b.tn) continue;
              lineId += 1;
              stmts.lines.bind([lineId, pageId, b.i, b.x, b.y, b.w, b.h, b.t, b.tn]).stepReset();
            }
          }
        }
      }
    }
  } finally {
    for (const st of Object.values(stmts)) st.finalize();
  }
}

/**
 * 把一份 sqlite 文件字节载入内存打开，供测试与函数版检索用。
 * 用 sqlite3_deserialize 而不是写进 wasm 的虚拟文件系统：不经过任何 VFS，Node 与浏览器行为一致。
 * FREEONCLOSE 让 sqlite 在关库时释放这段 wasm 内存；RESIZEABLE 允许之后写入（测试里改数据用）。
 *
 * 打开成功只保证「不是乱字节」：deserialize 不看内容，这里碰一下 sqlite_master 只读到第 1 页
 * 附近，整体截断也在这一步暴露；但中间某页坏掉的文件照样能开，要到查到那一页才报 SQLITE_CORRUPT。
 * 构建期刚导出、或整份载入后要长期查的场景传 verify: true，跑一遍 PRAGMA quick_check 把每一页
 * 都走到（全库扫描，与库大小成正比，默认关）。浏览器分块路径不需要——它逐块比 sha256。
 *
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {{verify?: boolean}} [opts]
 * @returns {Promise<import('@sqlite.org/sqlite-wasm').Database>}  用完记得 close()
 */
export async function openGalleryDb(bytes, { verify = false } = {}) {
  const u8 = asUint8(bytes);
  const sqlite3 = await initSqlite();
  const { capi, wasm } = sqlite3;
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    const p = wasm.allocFromTypedArray(u8);
    const rc = capi.sqlite3_deserialize(
      db.pointer,
      'main',
      p,
      u8.byteLength,
      u8.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    if (rc !== 0) throw new Error(`sqlite3_deserialize 失败：${capi.sqlite3_js_rc_str(rc)}`);
    // deserialize 只接管内存、不看内容：给它一段乱字节也返回成功，要到第一条查询才报
    // SQLITE_NOTADB。这里先碰一下 schema，让「根本不是 sqlite」在打开时就暴露，而不是留给调用方。
    db.selectValue('SELECT count(*) FROM sqlite_master');
    if (verify) {
      // 坏页会让 quick_check 直接抛 SQLITE_CORRUPT；较轻的问题（索引与表对不上等）则以文字行返回
      const problems = db.selectValues('PRAGMA quick_check').filter((r) => r !== 'ok');
      if (problems.length) throw new Error(`sqlite 文件校验未通过（quick_check）：${problems.join('；')}`);
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * 各实体表的行数。构建日志用它报数，测试用它与模型 totals 对账。
 * @param {import('@sqlite.org/sqlite-wasm').Database} db
 * @returns {{series: number, issues: number, chapters: number, pages: number, lines: number}}
 */
export function tableCounts(db) {
  const out = {};
  for (const t of TABLES) out[t] = Number(db.selectValue(`SELECT count(*) FROM ${t}`));
  return out;
}
