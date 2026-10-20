// data/meta 与 data/text 的 schema（ARCHITECTURE §4）。zod 是纯 JS，浏览器里也能跑。
//
// 这里的每条约束都对应站点或检索的一个假设：id 是 URL 段与图片 key 的一段，所以只许
// 小写字母数字连字符；页码从 1 连续递增，所以阅读器能按下标翻页、#p<n> 能直接定位；
// 坐标 0–1 且框不出界，所以文字层与分辨率无关。约束在这里拦，比在页面上表现成
// 404 或错位便宜得多。
import { z } from 'zod';

export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
export const HASH12_RE = /^[0-9a-f]{12}$/;
export const CHAPTER_KEY_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const id = z
  .string({
    // YAML 里不加引号的 012 会被读成数字 12；不猜它想写什么，直接让人加引号
    error: (iss) => (typeof iss.input === 'number' ? 'id 被 YAML 读成了数字——数字开头的 id 要加引号，例如 "012"' : undefined),
  })
  .regex(ID_RE, 'id 只能是小写字母、数字与连字符，且以字母数字开头（它是 URL 段，也是图片 key 的一段）');
const unit = z.number().min(0).max(1);

function uniqueBy(items, pick) {
  const seen = new Set();
  const dup = [];
  for (const it of items) {
    const k = pick(it);
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
  return dup;
}

export const PageSchema = z.strictObject({
  n: z.number().int().positive(),
  img: z.string().regex(HASH12_RE, 'img 是图片内容 sha256 的前 12 位十六进制（key 由它推出）'),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

export const ChapterSchema = z
  .strictObject({
    id,
    number: z.number(),
    title: z.string().min(1),
    pages: z.array(PageSchema).min(1, '一话至少一页'),
  })
  .refine((c) => c.pages.every((p, i) => p.n === i + 1), {
    message: '页码 n 必须从 1 起连续递增（阅读器按顺序翻页，#p<n> 深链按它定位）',
    path: ['pages'],
  });

export const IssueSchema = z
  .strictObject({
    id,
    number: z.number(),
    title: z.string().min(1),
    published: z
      .preprocess(
        // js-yaml 会把不加引号的 2020-01-01 读成 Date；两种写法都接受，统一成字符串
        (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
        z.string().regex(DATE_RE, 'published 写 YYYY-MM-DD'),
      )
      .optional(),
    chapters: z.array(ChapterSchema).min(1, '一期至少一话'),
  })
  .refine((iss) => uniqueBy(iss.chapters, (c) => c.id).length === 0, {
    message: '同一期里话的 id 重复',
    path: ['chapters'],
  });

export const SeriesSchema = z
  .strictObject({
    id,
    title: z.string().min(1),
    sort: z.number().int().default(0),
    // 作品元数据：都可选，旧 meta 不用补；cover 是封面图内容 sha256 前 12 位
    description: z.string().optional(),
    authors: z.array(z.string().min(1)).optional(),
    artists: z.array(z.string().min(1)).optional(),
    status: z.enum(['ongoing', 'completed', 'hiatus', 'cancelled']).optional(),
    year: z.number().int().min(1900).max(2999).optional(),
    tags: z.array(z.string().min(1)).optional(),
    altTitles: z.array(z.string().min(1)).optional(),
    cover: z.string().regex(HASH12_RE, 'cover 是封面图内容 sha256 的前 12 位（key 由它推出）').optional(),
    issues: z.array(IssueSchema).default([]),
  })
  .refine((s) => uniqueBy(s.issues, (i) => i.id).length === 0, {
    message: '同一作品里期的 id 重复',
    path: ['issues'],
  });

export const TextBoxSchema = z
  .strictObject({
    i: z.number().int().nonnegative(),
    x: unit,
    y: unit,
    // w/h 允许为 0：LabelPlus 的标签是一个点，不是框；阅读器对 0 尺寸的框画点标记
    w: unit,
    h: unit,
    t: z.string(),
    tn: z.string(),
  })
  .refine((b) => b.x + b.w <= 1 + 1e-6 && b.y + b.h <= 1 + 1e-6, {
    message: '框超出页面（x+w 或 y+h > 1）',
  });

export const ChapterTextSchema = z
  .strictObject({
    chapter: z.string().regex(CHAPTER_KEY_RE, 'chapter 是 <series>/<issue>/<chapter>'),
    pages: z.array(
      z
        .strictObject({
          n: z.number().int().positive(),
          boxes: z.array(TextBoxSchema),
        })
        .refine((p) => uniqueBy(p.boxes, (b) => b.i).length === 0, { message: '同一页里框的序号 i 重复', path: ['boxes'] }),
    ),
  })
  .refine((t) => uniqueBy(t.pages, (p) => p.n).length === 0, { message: '页码 n 重复', path: ['pages'] });

/** @typedef {z.infer<typeof SeriesSchema>} SeriesMeta */
/** @typedef {z.infer<typeof ChapterTextSchema>} ChapterText */

/** 把 zod 的问题列表压成给人看的行。 */
export function formatIssues(error, source = '') {
  return error.issues.map((i) => `${source ? source + ' ' : ''}${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`);
}

function parseWith(schema, raw, source, what) {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const lines = formatIssues(r.error, source);
    const err = new Error(`${what}不合法：\n  · ${lines.join('\n  · ')}`);
    err.issues = lines;
    throw err;
  }
  return r.data;
}

/** @returns {SeriesMeta} */
export function parseSeriesMeta(raw, { source = '' } = {}) {
  return parseWith(SeriesSchema, raw, source, 'data/meta');
}

/** @returns {ChapterText} */
export function parseChapterText(raw, { source = '' } = {}) {
  return parseWith(ChapterTextSchema, raw, source, 'data/text');
}
