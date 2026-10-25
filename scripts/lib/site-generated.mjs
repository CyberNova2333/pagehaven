// 把校验过的配置与数据模型写成 JSON 交给站点。
//
// 站点代码（packages/site）不许 import Node 内置模块（铁律 1），Astro 页面的 frontmatter 也算。
// 所以读 YAML、走 data/ 目录这些事全在这里（构建期、Node）做，站点只 import JSON——
// 由 Vite 处理，不是 Node。目录不入库（.gitignore），每次构建重生成。
//
// 写出的文件：
//   site-config.json                          校验过的 site.config.yaml
//   gallery.json                              只含结构（作品 / 期 / 话 / 页与图片 key），不含台词框
//   text/<series>/<issue>/<chapter>.json      每话的台词框（只给有台词稿的话写）
//
// 台词为什么按话拆：18 000 话的量级下，全部台词塞进一个 JSON 会有几百 MB，Vite 要把它整个
// 读进内存再序列化进每个页面的模块图。按话拆后阅读器页用 import.meta.glob 按需取自己那一份。
// 台词框里的 tn（归一化文本）不写：它只用于检索库，阅读器只展示 t，省一半体积。
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SITE_GENERATED_DIR } from './paths.mjs';

export const SITE_CONFIG_JSON = join(SITE_GENERATED_DIR, 'site-config.json');
export const SITE_GALLERY_JSON = join(SITE_GENERATED_DIR, 'gallery.json');
export const SITE_TEXT_DIR = join(SITE_GENERATED_DIR, 'text');

/**
 * 作品 id 不能撞站点自己的固定路由与固定文件：/search/ 是检索页、/api/ 是可选函数的探测路径、
 * /index/ 放索引分片、index/series.json 是索引总表、404 与 CNAME 是平台基线文件（大小写不敏感的
 * 文件系统上 cname/ 目录会与 CNAME 文件相撞）。Astro 只会静默地让静态路由赢，不会报错——
 * 撞上时作品页整个消失，所以在这里拦。
 */
export const RESERVED_SERIES_IDS = ['search', 'api', 'index', 'series', '404', 'cname'];

/** @param {import('@gallery/core').Gallery} gallery */
export function assertNoReservedIds(gallery) {
  const bad = gallery.series.filter((s) => RESERVED_SERIES_IDS.includes(s.id)).map((s) => s.id);
  if (bad.length) {
    throw new Error(`作品 id 与站点固定路由冲突：${bad.join(', ')}（保留字：${RESERVED_SERIES_IDS.join(' ')}）`);
  }
}

/** @param {import('@gallery/platform').SiteConfig} config */
export async function writeSiteConfigJson(config, { preview = false } = {}) {
  await mkdir(SITE_GENERATED_DIR, { recursive: true });
  await writeFile(SITE_CONFIG_JSON, JSON.stringify({ ...config, preview }, null, 2) + '\n');
  return SITE_CONFIG_JSON;
}

/**
 * gallery.json 的形状：模型去掉 boxes 与摊平的 chapters 列表（后者与 series 树是同一批对象，
 * 序列化会写两遍）。页面需要摊平列表时自己 flatMap，几万条也只是毫秒级。
 * @param {import('@gallery/core').Gallery} gallery
 */
export function galleryStructure(gallery, { searchDb = null } = {}) {
  return {
    series: gallery.series.map((s) => ({
      id: s.id,
      title: s.title,
      sort: s.sort,
      url: s.url,
      description: s.description,
      authors: s.authors,
      artists: s.artists,
      status: s.status,
      year: s.year,
      tags: s.tags,
      altTitles: s.altTitles,
      cover: s.cover,
      coverKey: s.coverKey,
      issues: s.issues.map((iss) => ({
        id: iss.id,
        number: iss.number,
        title: iss.title,
        published: iss.published ?? null,
        url: iss.url,
        seriesId: iss.seriesId,
        chapters: iss.chapters.map((c) => ({
          id: c.id,
          number: c.number,
          title: c.title,
          key: c.key,
          url: c.url,
          seriesId: c.seriesId,
          issueId: c.issueId,
          hasText: c.hasText,
          prev: c.prev,
          next: c.next,
          pages: c.pages.map((p) => ({ n: p.n, img: p.img, w: p.w, h: p.h, keys: p.keys })),
        })),
      })),
    })),
    totals: gallery.totals,
    searchDb,
  };
}

/**
 * 一话的台词文件：只写有框的页；框只留展示要用的字段。
 * @param {import('@gallery/core').ChapterModel} chapter
 */
export function chapterTextFile(chapter) {
  return {
    chapter: chapter.key,
    pages: chapter.pages
      .filter((p) => p.boxes.length > 0)
      .map((p) => ({ n: p.n, boxes: p.boxes.map((b) => ({ i: b.i, x: b.x, y: b.y, w: b.w, h: b.h, t: b.t })) })),
  };
}

/**
 * 写 gallery.json 与 text/ 分片。text/ 先整个删掉再写：上次构建留下的、如今已从 data/ 撤掉的话
 * 不该还能被 glob 到。
 * @param {import('@gallery/core').Gallery} gallery
 * @returns {Promise<{galleryFile: string, textFiles: string[]}>}
 */
export async function writeSiteGalleryJson(gallery, options = {}) {
  assertNoReservedIds(gallery);
  await mkdir(SITE_GENERATED_DIR, { recursive: true });
  await writeFile(SITE_GALLERY_JSON, JSON.stringify(galleryStructure(gallery, options)) + '\n');
  await rm(SITE_TEXT_DIR, { recursive: true, force: true });
  // 0 话时也建空目录：让「目录在不在」不成为 glob 行为的变量
  await mkdir(SITE_TEXT_DIR, { recursive: true });
  const textFiles = [];
  for (const c of gallery.chapters) {
    if (!c.hasText) continue;
    const file = join(SITE_TEXT_DIR, ...c.key.split('/')) + '.json';
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(chapterTextFile(c)) + '\n');
    textFiles.push(file);
  }
  return { galleryFile: SITE_GALLERY_JSON, textFiles };
}
