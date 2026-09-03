// @gallery/core —— 数据模型、解析器、归一化、DB 构建、取块层（CLAUDE.md 铁律 1：只用 Web 标准 API）。
//
// 子路径导出（package.json 的 "./*"）同样可用：只要模型与 schema 的调用方可以 import
// '@gallery/core/schema' 之类，免得把 sqlite wasm 与 OpenCC 词典一起拉进来。
export {
  SeriesSchema,
  IssueSchema,
  ChapterSchema,
  PageSchema,
  ChapterTextSchema,
  TextBoxSchema,
  parseSeriesMeta,
  parseChapterText,
  formatIssues,
  ID_RE,
  HASH12_RE,
  CHAPTER_KEY_RE,
} from './schema.js';
export { buildGallery, chapterKey, issueKey, urlFor, imageKey } from './model.js';
export { normalizeText } from './normalize.js';
export { parseLabelPlus, labelPlusToChapterText, pageByNumberInName, pageBySequence, choosePageOf } from './labelplus.js';
export {
  buildGalleryDb,
  openGalleryDb,
  initSqlite,
  tableCounts,
  TABLES,
  SCHEMA_SQL,
  computeChunkManifest,
  chunkCount,
  chunkRange,
  sha256Hex,
  CHUNK_MANIFEST_VERSION,
} from './db/index.js';
export * from './chunkfetch/index.js';
