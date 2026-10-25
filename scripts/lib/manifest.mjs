// manifest.json 的形状与生成（纯函数）。
//
// manifest 是一次发布的「目录」：站点引用了哪些图片 key、每话的 URL、当前检索库指向哪一份。
// publish:r2 按它决定传什么，status 按它写 STATUS.md，检索端按 db 字段找库。生成逻辑抽成
// 纯函数是为了能直接单测形状，而不用每次 spawn 脚本。
//
// 键顺序是稳定的（对象字面量按书写顺序序列化）：同一份数据两次构建得到逐字节相同的文件，
// 只有 version / generatedAt 会变，diff 一眼能看出来。
//
// db 字段这里恒为 null：build:db 在之后跑，读回 manifest.json 只填 db 字段、其余原样保留
// （形状见 scripts/build-db.mjs）。build:manifest 不知道也不该猜库的版本与摘要。
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const MANIFEST_FILE = 'manifest.json';

export const galleryFingerprint = (gallery) => createHash('sha256').update(JSON.stringify(gallery)).digest('hex');

/** 版本号进文件名与对象 key：只放字母数字与 . _ -，路径分隔符与空白一律拒收。 */
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 版本取 RELEASE_VERSION（发布流水线给），没有就用 UTC 日期——与 build:db 同一条规则，
 * 两个脚本必须得到同一个版本号，否则 manifest 与库文件名对不上。
 * @param {Record<string, string|undefined>} [env]
 * @param {Date} [now]
 */
export function resolveVersion(env = process.env, now = new Date()) {
  const version = env.RELEASE_VERSION || now.toISOString().slice(0, 10);
  if (!VERSION_RE.test(version)) {
    throw new Error(`RELEASE_VERSION 只能是字母数字与 . _ -（它是文件名与对象 key 的一段）：${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * @typedef {object} Manifest
 * @property {string} version
 * @property {string} generatedAt  ISO 8601（UTC）
 * @property {string} sourceSha256 元数据与完整台词内容的摘要，阻止旧 DB 与新页面混用
 * @property {{ domain: string }} site
 * @property {{ hosts: string[], prefix: string }} images
 * @property {{ series: number, issues: number, chapters: number, pages: number, boxes: number }} totals
 * @property {ManifestSeries[]} series
 * @property {string[]} imageKeys  全部 webp 的对象 key，按字节序排序
 * @property {ManifestDb|null} db  build:manifest 恒写 null，build:db 之后填
 */
/**
 * 当前检索库指针；形状由 scripts/build-db.mjs 定，这里只是给读的一方看。
 * @typedef {object} ManifestDb
 * @property {string} version
 * @property {string} key        对象存储里的库 key（版本化）
 * @property {number} size
 * @property {string} sha256
 * @property {number} pageSize
 * @property {number} chunkSize
 * @property {string} chunks     分块摘要文件的 key
 */
/**
 * @typedef {object} ManifestSeries
 * @property {string} id
 * @property {string} title
 * @property {string} url
 * @property {{ id: string, number: number, title: string, published: string|null, url: string,
 *   chapters: { key: string, url: string, pages: number, hasText: boolean }[] }[]} issues
 */

/** 字节序比较：与对象存储列表的顺序一致，核对清单时两边都是有序的。 */
const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {import('@gallery/core').Gallery} gallery
 * @param {import('@gallery/platform').SiteConfig} config
 * @param {{ version: string, generatedAt?: string }} opts
 * @returns {Manifest}
 */
export function buildManifest(gallery, config, { version, generatedAt = new Date().toISOString() }) {
  const imageKeys = [
    ...gallery.chapters.flatMap((c) => c.pages.map((p) => p.keys.webp)),
    ...gallery.series.map((s) => s.coverKey).filter(Boolean),
  ].sort(byteOrder);
  return {
    version,
    generatedAt,
    sourceSha256: galleryFingerprint(gallery),
    site: { domain: config.site.domain },
    images: { hosts: [...config.images.hosts], prefix: config.images.prefix },
    totals: { ...gallery.totals },
    series: gallery.series.map((s) => ({
      id: s.id,
      title: s.title,
      url: s.url,
      description: s.description,
      authors: s.authors,
      artists: s.artists,
      status: s.status,
      year: s.year,
      tags: s.tags,
      altTitles: s.altTitles,
      coverKey: s.coverKey,
      issues: s.issues.map((iss) => ({
        id: iss.id,
        number: iss.number,
        title: iss.title,
        // 没有 published 写 null 而不是省略：读的一方按固定形状取，不用逐条判断 key 在不在
        published: iss.published ?? null,
        url: iss.url,
        chapters: iss.chapters.map((c) => ({ key: c.key, url: c.url, pages: c.pages.length, hasText: c.hasText })),
      })),
    })),
    imageKeys,
    db: null,
  };
}

/**
 * 读 OUT_DIR/manifest.json。不存在返回 null（调用方决定这算不算错：build:db 跳过，status 报错）。
 * @param {string} outDir
 * @returns {Promise<Manifest | null>}
 */
export async function readManifest(outDir) {
  try {
    return JSON.parse(await readFile(join(outDir, MANIFEST_FILE), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
