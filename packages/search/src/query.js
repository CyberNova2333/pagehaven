// 台词查询：归一化查询串、按长度选 MATCH / LIKE、把结果 join 回坐标与话。
//
// 与构建端的约定全部来自 ARCHITECTURE §4：
//   · 查询串走与索引文本同一个 normalizeText（NFKC → 去符号 → OpenCC 繁→简 → 小写），
//     否则「契約」敲不出来、全角字母也匹配不上；
//   · ≥ 3 字走 FTS5 trigram 的 MATCH；恰好 2 字 MATCH 不命中（trigram 最少三个字），
//     退回 LIKE 全表扫；1 字拒绝——它等于全表翻一遍，且几乎必然几千条结果；
//   · 结果 join lines → pages → chapters → issues → series，链到 /<series>/<issue>/<chapter>/#p<n>b<i>，
//     阅读器按这个 hash 高亮那个框（ARCHITECTURE §4 的「结果带 bbox」）。
//
// 纯函数：db 由调用方传入（浏览器里是 openGalleryDb 打开的内存库，测试里是同一份），这里不碰网络与 DOM。

import { normalizeText } from '@gallery/core';

/** 每批结果最多多少行；多取一条判断是否有下一批，不把截断长度当成总数。 */
export const RESULT_LIMIT = 50;

/** FTS5 短语：给整串加引号并转义内部双引号，用户输入的语法字符不会被当成查询语法。 */
export function ftsPhrase(normalized) {
  return `"${normalized.replace(/"/g, '""')}"`;
}

/** LIKE 的转义：% _ \ 都是通配 / 转义符，查询串里的它们要按字面匹配。 */
export function likePattern(normalized) {
  return `%${normalized.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * 结果行的 SQL 骨架。两字 LIKE 直接扫正文；MATCH 才连接 FTS 索引。
 * 排序按作品 / 期 / 话 / 页 / 框：同一句话在多话里出现时，读者的直觉顺序是书架顺序。
 */
const SELECT_SQL = `
  SELECT s.id AS series_id, s.title AS series_title,
         i.id AS issue_id, i.title AS issue_title, i.number AS issue_number,
         c.id AS chapter_id, c.title AS chapter_title, c.number AS chapter_number, c.url AS chapter_url,
         p.n AS page_n, l.ord AS box_i, l.text AS text, l.x AS x, l.y AS y, l.w AS w, l.h AS h
  FROM lines l
  JOIN pages p ON p.id = l.page_id
  JOIN chapters c ON c.id = p.chapter_id
  JOIN issues i ON i.id = c.issue_id
  JOIN series s ON s.id = i.series_id
`;

const ORDER_SQL = ' ORDER BY s.sort, s.id, i.number, i.id, c.number, c.id, p.n, l.ord, l.id LIMIT ? OFFSET ?';

/** 查询是否足够长与数据库无关，页面先判断，避免为单字或纯标点下载整库。 */
export function prepareQuery(rawQuery) {
  const normalized = normalizeText(String(rawQuery ?? ''));
  const length = [...normalized].length;
  return { normalized, mode: length < 2 ? 'too-short' : length >= 3 ? 'match' : 'like' };
}

/** 行 → 页面可直接用的结果对象。url 里的 hash 与阅读器约定一致：#p<n>b<i>。 */
function toResult(row) {
  return {
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    issueId: row.issue_id,
    issueTitle: row.issue_title,
    issueNumber: row.issue_number,
    chapterId: row.chapter_id,
    chapterTitle: row.chapter_title,
    chapterNumber: row.chapter_number,
    chapterUrl: row.chapter_url,
    pageN: row.page_n,
    boxI: row.box_i,
    text: row.text,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    url: `${row.chapter_url}#p${row.page_n}b${row.box_i}`,
  };
}

/**
 * 查台词。
 * @param {import('@sqlite.org/sqlite-wasm').Database} db
 * @param {string} rawQuery  用户输入的原文（内部做 normalizeText）
 * @param {{ limit?: number, offset?: number, seriesId?: string }} [opts]
 * @returns {{ mode: string, normalized: string, rows: object[], hasMore: boolean }}
 */
export function queryLines(db, rawQuery, { limit = RESULT_LIMIT, offset = 0, seriesId = '' } = {}) {
  const { normalized, mode } = prepareQuery(rawQuery);
  if (mode === 'too-short') return { mode, normalized, rows: [], hasMore: false };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RESULT_LIMIT) throw new RangeError(`limit 必须在 1–${RESULT_LIMIT} 之间`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset 必须是非负整数');
  const where = mode === 'match'
    ? ' JOIN lines_fts ON lines_fts.rowid = l.id WHERE lines_fts MATCH ?'
    : " WHERE l.text_norm LIKE ? ESCAPE '\\'";
  const bind = [mode === 'match' ? ftsPhrase(normalized) : likePattern(normalized)];
  if (seriesId) bind.push(seriesId);
  bind.push(limit + 1, offset);
  const rows = db.selectObjects(`${SELECT_SQL}${where}${seriesId ? ' AND s.id = ?' : ''}${ORDER_SQL}`, bind);
  return { mode, normalized, rows: rows.slice(0, limit).map(toResult), hasMore: rows.length > limit };
}
