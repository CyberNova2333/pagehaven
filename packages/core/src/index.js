// @gallery/core —— 数据模型、解析器、归一化、DB 构建、取块层（CLAUDE.md 铁律 1：只用 Web 标准 API）。
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
export { buildGallery, chapterKey, urlFor, imageKey } from './model.js';
