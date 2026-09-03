// 由校验过的 meta + text 组装成站点、索引、DB 构建共用的内存模型。
//
// 模型是「纯数据」：只有字符串、数字与数组，没有类、没有方法、没有循环引用，所以能直接
// JSON 序列化交给 Astro 页面、写进索引分片、或喂给 DB 构建。key / URL / 图片 key 的拼法
// 只在这里出现一次——它们是站点、sitemap、manifest、对象存储四处都要一致的东西。
import { CHAPTER_KEY_RE } from './schema.js';

/** @param {string} seriesId @param {string} issueId @param {string} chapterId */
export function chapterKey(seriesId, issueId, chapterId) {
  return `${seriesId}/${issueId}/${chapterId}`;
}

/** 站点 URL：每级一个目录、以 / 结尾（Astro build.format=directory + trailingSlash=always）。 */
export function urlFor(...segments) {
  return '/' + segments.join('/') + '/';
}

/**
 * 图片在对象存储里的 key（ARCHITECTURE §4）：`img/<series>/<issue>/<chapter>/<n>-<hash12>.<ext>`。
 * 内容哈希进文件名 = 不可变，修图就是新 key + 重建引用页，不依赖清缓存。
 */
export function imageKey(prefix, key, n, hash, ext) {
  return `${prefix}${key}/${n}-${hash}.${ext}`;
}

/**
 * @typedef {object} PageModel
 * @property {number} n
 * @property {string} img  内容哈希前 12 位
 * @property {number} w
 * @property {number} h
 * @property {{avif: string, webp: string}} keys  对象存储 key（不含域名）
 * @property {import('./schema.js').ChapterText['pages'][number]['boxes']} boxes  文字层，没有台词稿则为空数组
 */
/**
 * @typedef {object} ChapterModel
 * @property {string} id
 * @property {number} number
 * @property {string} title
 * @property {string} key      <series>/<issue>/<chapter>
 * @property {string} url
 * @property {string} seriesId
 * @property {string} issueId
 * @property {PageModel[]} pages
 * @property {boolean} hasText
 * @property {string|null} prev  同一作品内上一话的 key（跨期），没有则 null
 * @property {string|null} next
 */
/**
 * @typedef {object} IssueModel
 * @property {string} id
 * @property {number} number
 * @property {string} title
 * @property {string|undefined} published
 * @property {string} url
 * @property {string} seriesId
 * @property {ChapterModel[]} chapters
 */
/**
 * @typedef {object} SeriesModel
 * @property {string} id
 * @property {string} title
 * @property {number} sort
 * @property {string} url
 * @property {IssueModel[]} issues
 */
/**
 * @typedef {object} Gallery
 * @property {SeriesModel[]} series  按 sort、再按 title 排序
 * @property {ChapterModel[]} chapters  全部话，按作品 / 期 / 话顺序摊平
 * @property {{series: number, issues: number, chapters: number, pages: number, boxes: number}} totals
 */

/**
 * @param {import('./schema.js').SeriesMeta[]} seriesList
 * @param {Map<string, import('./schema.js').ChapterText>} textsByKey  以 chapter key 为键
 * @param {{imagePrefix?: string}} [opts]
 * @returns {Gallery}
 */
export function buildGallery(seriesList, textsByKey = new Map(), { imagePrefix = 'img/' } = {}) {
  const problems = [];
  const dupSeries = new Set();
  const seenSeries = new Set();
  for (const s of seriesList) {
    if (seenSeries.has(s.id)) dupSeries.add(s.id);
    seenSeries.add(s.id);
  }
  for (const d of dupSeries) problems.push(`作品 id 重复：${d}`);

  const byNumberThenId = (a, b) => a.number - b.number || a.id.localeCompare(b.id);
  const series = [...seriesList]
    .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title, 'zh') || a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      title: s.title,
      sort: s.sort,
      url: urlFor(s.id),
      issues: [...s.issues].sort(byNumberThenId).map((iss) => ({
        id: iss.id,
        number: iss.number,
        title: iss.title,
        published: iss.published,
        url: urlFor(s.id, iss.id),
        seriesId: s.id,
        chapters: [...iss.chapters].sort(byNumberThenId).map((ch) => {
          const key = chapterKey(s.id, iss.id, ch.id);
          const text = textsByKey.get(key);
          const boxesByN = new Map((text?.pages ?? []).map((p) => [p.n, p.boxes]));
          if (text) {
            for (const n of boxesByN.keys()) {
              if (n > ch.pages.length) problems.push(`${key} 的台词稿有第 ${n} 页，但 meta 里这一话只有 ${ch.pages.length} 页`);
            }
          }
          return {
            id: ch.id,
            number: ch.number,
            title: ch.title,
            key,
            url: urlFor(s.id, iss.id, ch.id),
            seriesId: s.id,
            issueId: iss.id,
            hasText: Boolean(text),
            prev: null,
            next: null,
            pages: ch.pages.map((p) => ({
              n: p.n,
              img: p.img,
              w: p.w,
              h: p.h,
              keys: {
                avif: imageKey(imagePrefix, key, p.n, p.img, 'avif'),
                webp: imageKey(imagePrefix, key, p.n, p.img, 'webp'),
              },
              boxes: (boxesByN.get(p.n) ?? []).slice().sort((a, b) => a.i - b.i),
            })),
          };
        }),
      })),
    }));

  const known = new Set(series.flatMap((s) => s.issues.flatMap((i) => i.chapters.map((c) => c.key))));
  for (const key of textsByKey.keys()) {
    if (!CHAPTER_KEY_RE.test(key)) problems.push(`台词稿的 chapter 不是 <series>/<issue>/<chapter>：${key}`);
    else if (!known.has(key)) problems.push(`台词稿 ${key} 在 meta 里没有对应的话`);
  }
  if (problems.length) {
    const err = new Error(`meta 与 text 对不上：\n  · ${problems.join('\n  · ')}`);
    err.issues = problems;
    throw err;
  }

  const chapters = series.flatMap((s) => s.issues.flatMap((i) => i.chapters));
  // 上一话 / 下一话在同一作品内跨期串起来：读者读完一卷最后一话，下一步是下一卷第一话
  for (const s of series) {
    const list = s.issues.flatMap((i) => i.chapters);
    list.forEach((c, i) => {
      c.prev = i > 0 ? list[i - 1].key : null;
      c.next = i + 1 < list.length ? list[i + 1].key : null;
    });
  }
  const totals = {
    series: series.length,
    issues: series.reduce((n, s) => n + s.issues.length, 0),
    chapters: chapters.length,
    pages: chapters.reduce((n, c) => n + c.pages.length, 0),
    boxes: chapters.reduce((n, c) => n + c.pages.reduce((m, p) => m + p.boxes.length, 0), 0),
  };
  return { series, chapters, totals };
}
