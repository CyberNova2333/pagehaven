// publish:r2 的上传计划（纯函数）：本次发布要往对象存储放哪些对象、各用什么 key / Content-Type /
// Cache-Control。计算不碰文件系统与网络——脚本负责列目录、读文件、上传，这里只负责「决定」，
// 所以 key 与缓存头这些文档约定（ARCHITECTURE §4、§7）能直接单测，不用真连存储。
//
// 缓存头的取舍：
//   · 带版本号的 key（gallery-<v>.sqlite、.chunks.json、site-<v>.tar.zst）内容不会再变，
//     给一年 immutable，CDN 与浏览器都可以放心久存；
//   · manifest.json 是「当前版本指针」，切版本靠改它，所以只给 5 分钟；
//   · 图片 key 里带内容哈希，同样一年 immutable；而且同 key 字节一定相同，已存在就不必重传。
// Content-Type 的取舍：DB 与 chunks.json 都用 application/octet-stream——chunks.json 明明是 JSON，
// 但 CDN 的智能压缩会对 text/json 类型套 Content-Encoding，带压缩的响应 Content-Length 是压缩后
// 长度，Range 语义整个变味（§7）；取块层按 64 KB 对齐取 Range，两份文件都必须逃过压缩。
//
// 上传顺序就是数组顺序，manifest.json 排最后：它一换，检索端就按新指针取库，所以必须等库、
// 归档、图片都在位并核对过之后再换。发布中途失败时指针仍指向上一版，线上不会坏。
import { basename } from 'node:path';

export const CACHE_IMMUTABLE_YEAR = 'public, max-age=31536000, immutable';
export const CACHE_MANIFEST = 'public, max-age=300';
export const CONTENT_TYPE_OCTET = 'application/octet-stream';
export const CONTENT_TYPE_MANIFEST = 'application/json; charset=utf-8';
/** tar.zst 的注册类型；归档只供整份下载，不走 Range，用准确类型即可。 */
export const CONTENT_TYPE_ARCHIVE = 'application/zstd';
/** dist 归档在存储里的前缀（ARCHITECTURE §5：site-<date>.tar.zst）。 */
export const ARCHIVE_PREFIX = 'archive/';
export const MANIFEST_KEY_NAME = 'manifest.json';
/** 图片按扩展名定 Content-Type；只用 webp（avif 编码慢、体积并不更小，已弃用）。 */
export const IMAGE_CONTENT_TYPES = { webp: 'image/webp' };

/** 与 build:db 同一条命名规则：out/db 里只该有这一对文件。 */
export function dbFileNames(version) {
  const db = `gallery-${version}.sqlite`;
  return { db, chunks: `${db}.chunks.json` };
}

export function archiveFileName(version) {
  return `site-${version}.tar.zst`;
}

/**
 * @typedef {object} Upload
 * @property {'db'|'chunks'|'archive'|'image'|'manifest'} kind
 * @property {string} key           对象存储 key
 * @property {string} path          本地文件路径（脚本传进来什么就原样带回）
 * @property {string} contentType
 * @property {string} cacheControl
 * @property {boolean} skipIfExists 先查再传：只有图片（内容哈希 key，同 key 字节一定相同）
 */

/**
 * @typedef {object} PublishPlan
 * @property {string} version
 * @property {Upload[]} uploads      按上传顺序；manifest 最后
 * @property {string[]} verifyKeys   上传完要逐个 head 核对存在的 key（manifest 引用的全部图片）
 * @property {{ dir: boolean, uploads: number, ignored: string[], unsupported: string[] }} images
 *   dir：有没有给图片目录；ignored：目录里有但 manifest 没引用的文件；unsupported：扩展名不认识的
 */

/** 目录遍历得到的相对路径统一成 posix 形式，才能与 key 拼接。 */
function toPosix(rel) {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * @param {object} input
 * @param {string} input.version
 * @param {import('@gallery/platform').SiteConfig} input.config
 * @param {import('./manifest.mjs').Manifest} input.manifest   out/manifest.json 的内容
 * @param {object} input.files
 * @param {string[]} input.files.db           out/db 下的文件路径（全部；多了少了都是问题）
 * @param {number} [input.files.dbSize]       库文件的实际字节数（脚本 stat 得到）；给了就与 manifest.db.size 比
 * @param {string} input.files.manifest       out/manifest.json 的路径
 * @param {string} input.files.distArchive    归档文件路径（脚本决定放哪；还没建也先给路径）
 * @param {string[]|null} input.files.images  图片目录里的文件，相对图片目录的路径；没给目录传 null
 * @returns {PublishPlan}
 */
export function planUploads({ version, config, manifest, files }) {
  const problems = [];
  const names = dbFileNames(version);
  const dbKey = config.db.prefix + names.db;
  const chunksKey = config.db.prefix + names.chunks;

  if (manifest.version !== version) {
    problems.push(`manifest.json 的版本是 ${manifest.version}，本次发布版本是 ${version}（RELEASE_VERSION 与 build 时不一致？）`);
  }
  if (!manifest.db) {
    problems.push('manifest.json 没有 db 字段（build:db 没跑？发布不能没有检索库指针）');
  } else {
    if (manifest.db.key !== dbKey) problems.push(`manifest.json 的 db.key 是 ${manifest.db.key}，本次应为 ${dbKey}`);
    if (manifest.db.chunks !== chunksKey) problems.push(`manifest.json 的 db.chunks 是 ${manifest.db.chunks}，本次应为 ${chunksKey}`);
    // 名字对得上不等于是同一份：manifest 记了 size，一次比对就能抓住「manifest 与库来自不同次构建」
    if (typeof files.dbSize === 'number' && typeof manifest.db.size === 'number' && files.dbSize !== manifest.db.size) {
      problems.push(`manifest.json 记的库大小是 ${manifest.db.size} 字节，out/db 里的 ${names.db} 实际 ${files.dbSize} 字节（manifest 与库来自不同次构建？重新 npm run build）`);
    }
  }

  const dbFiles = new Map((files.db ?? []).map((p) => [basename(p), p]));
  for (const want of [names.db, names.chunks]) {
    if (!dbFiles.has(want)) problems.push(`out/db 里没有 ${want}（先 npm run build:db）`);
  }
  for (const have of dbFiles.keys()) {
    if (have !== names.db && have !== names.chunks) problems.push(`out/db 里有不属于本版本的文件 ${have}（out/db 只该有当前版本这一对；重新 build:db）`);
  }
  if (!Array.isArray(manifest.imageKeys)) problems.push('manifest.json 没有 imageKeys');
  if (problems.length) {
    const err = new Error(`上传计划无法成立（共 ${problems.length} 处）：\n  · ${problems.join('\n  · ')}`);
    err.issues = problems;
    throw err;
  }

  const uploads = [
    { kind: 'db', key: dbKey, path: dbFiles.get(names.db), contentType: CONTENT_TYPE_OCTET, cacheControl: CACHE_IMMUTABLE_YEAR, skipIfExists: false },
    { kind: 'chunks', key: chunksKey, path: dbFiles.get(names.chunks), contentType: CONTENT_TYPE_OCTET, cacheControl: CACHE_IMMUTABLE_YEAR, skipIfExists: false },
    { kind: 'archive', key: ARCHIVE_PREFIX + archiveFileName(version), path: files.distArchive, contentType: CONTENT_TYPE_ARCHIVE, cacheControl: CACHE_IMMUTABLE_YEAR, skipIfExists: false },
  ];

  const wanted = new Set(manifest.imageKeys);
  const images = { dir: files.images != null, uploads: 0, ignored: [], unsupported: [] };
  const imageUploads = [];
  for (const rel of files.images ?? []) {
    const posix = toPosix(rel);
    const key = config.images.prefix + posix;
    if (!wanted.has(key)) {
      images.ignored.push(posix);
      continue;
    }
    const ext = posix.slice(posix.lastIndexOf('.') + 1).toLowerCase();
    const contentType = IMAGE_CONTENT_TYPES[ext];
    if (!contentType) {
      images.unsupported.push(posix);
      continue;
    }
    imageUploads.push({ kind: 'image', key, path: rel, contentType, cacheControl: CACHE_IMMUTABLE_YEAR, skipIfExists: true });
  }
  // 按 key 排序：日志与存储列表同序，也让同一份输入的计划逐字相同
  imageUploads.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  images.uploads = imageUploads.length;
  uploads.push(...imageUploads);

  uploads.push({
    kind: 'manifest',
    key: config.db.prefix + MANIFEST_KEY_NAME,
    path: files.manifest,
    contentType: CONTENT_TYPE_MANIFEST,
    cacheControl: CACHE_MANIFEST,
    skipIfExists: false,
  });

  return { version, uploads, verifyKeys: [...manifest.imageKeys], images };
}
