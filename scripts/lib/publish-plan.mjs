// publish:r2 的上传计划（纯函数）：本次发布要往对象存储放哪些对象、各用什么 key / Content-Type /
// Cache-Control。计算不碰文件系统与网络——脚本负责列目录、读文件、上传，这里只负责「决定」，
// 所以 key 与缓存头这些文档约定（ARCHITECTURE §4、§7）能直接单测，不用真连存储。
//
// 缓存头的取舍：
//   · 带版本号的 key（gallery-<v>.sqlite、.chunks.json、site-<v>.tar.zst）内容不会再变，
//     给一年 immutable，CDN 与浏览器都可以放心久存；
//   · 版本 manifest 也是不可变对象；共享指针由启用步骤另行更新，缓存只给 5 分钟；
//   · 图片 key 里带内容哈希，同样一年 immutable；而且同 key 字节一定相同，已存在就不必重传。
// Content-Type 的取舍：DB 与 chunks.json 都用 application/octet-stream——chunks.json 明明是 JSON，
// 但 CDN 的智能压缩会对 text/json 类型套 Content-Encoding，带压缩的响应 Content-Length 是压缩后
// 长度，Range 语义整个变味（§7）；取块层按 64 KB 对齐取 Range，两份文件都必须逃过压缩。
//
// 上传顺序就是数组顺序，版本 manifest 排最后：库、归档和图片核对通过才可使用该版本。
// 本阶段不读写共享 manifest.json；正式部署成功后由单独的启用步骤更新当前版本。
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CHUNK_MANIFEST_VERSION, computeChunkManifest } from '@gallery/core/db/chunks';
import { isSafeObjectKey, isSafeObjectPrefix } from '@gallery/core/object-path';

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

/** 每个站点版本绑定自己的 manifest；共享 manifest.json 只在部署成功后启用。 */
export function releaseManifestFileName(version) {
  return `manifest-${version}.json`;
}

/** 重建时间不改变版本内容；保留第一次上传的生成时间和 JSON 原文。 */
export function sameReleaseManifest(previous, next) {
  try {
    const left = JSON.parse(Buffer.from(previous).toString('utf8'));
    const right = JSON.parse(Buffer.from(next).toString('utf8'));
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false;
    delete left.generatedAt;
    delete right.generatedAt;
    return isDeepStrictEqual(left, right);
  } catch {
    return false;
  }
}

/** 发布使用这次校验的同一份字节，避免只比长度或校验后再次读盘。 */
export async function verifyDbArtifacts({ manifest, dbConfig, dbBytes, chunksBytes }) {
  const reject = (problem) => {
    const error = new Error(`发布完整性校验失败：${problem}`);
    error.issues = [problem];
    throw error;
  };
  const meta = manifest.db;
  if (!meta || meta.version !== manifest.version) reject('数据库版本与 manifest 不一致');
  if (!Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size !== dbBytes.byteLength) reject('数据库实际长度与 manifest 不一致');
  if (meta.pageSize !== dbConfig.page_size || meta.chunkSize !== dbConfig.chunk_size) reject('数据库页大小或分块大小与站点配置不一致');
  if (typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(meta.sha256)) reject('manifest.db.sha256 无效');
  let chunks;
  try { chunks = JSON.parse(Buffer.from(chunksBytes).toString('utf8')); }
  catch { reject('分块摘要不是有效 JSON'); }
  if (!chunks || chunks.version !== CHUNK_MANIFEST_VERSION || chunks.totalBytes !== meta.size || chunks.chunkSize !== meta.chunkSize) reject('分块摘要的版本、长度或块大小与 manifest 不一致');
  const actual = await computeChunkManifest(dbBytes, meta.chunkSize);
  if (actual.sha256 !== meta.sha256.toLowerCase()) reject('数据库实际 SHA-256 与 manifest.db.sha256 不一致');
  if (typeof chunks.sha256 !== 'string' || chunks.sha256.toLowerCase() !== actual.sha256) reject('分块摘要的整份 SHA-256 与数据库不一致');
  if (!Array.isArray(chunks.chunks) || chunks.chunks.length !== actual.chunks.length
    || chunks.chunks.some((hash, index) => typeof hash !== 'string' || hash.toLowerCase() !== actual.chunks[index])) reject('数据库实际分块 SHA-256 与分块摘要不一致');
}

/**
 * @typedef {object} Upload
 * @property {'db'|'chunks'|'archive'|'image'|'manifest'} kind
 * @property {string} key           对象存储 key
 * @property {string} path          本地文件路径（脚本传进来什么就原样带回）
 * @property {string} contentType
 * @property {string} cacheControl
 * @property {boolean} skipIfExists 已存在时核对内容，相同跳过、不同拒绝；新对象用条件写入创建
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

  if (!isSafeObjectPrefix(config.db.prefix) || !isSafeObjectKey(dbKey) || !isSafeObjectKey(chunksKey)) {
    problems.push('db.prefix 必须是以 / 结尾且没有空段或点段的 ASCII 相对对象前缀');
  }

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
    { kind: 'db', key: dbKey, path: dbFiles.get(names.db), contentType: CONTENT_TYPE_OCTET, cacheControl: CACHE_IMMUTABLE_YEAR, skipIfExists: true },
    { kind: 'chunks', key: chunksKey, path: dbFiles.get(names.chunks), contentType: CONTENT_TYPE_OCTET, cacheControl: CACHE_IMMUTABLE_YEAR, skipIfExists: true },
    { kind: 'archive', key: ARCHIVE_PREFIX + archiveFileName(version), path: files.distArchive, contentType: CONTENT_TYPE_ARCHIVE, cacheControl: CACHE_IMMUTABLE_YEAR, skipIfExists: true },
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
    key: config.db.prefix + releaseManifestFileName(version),
    path: files.manifest,
    contentType: CONTENT_TYPE_MANIFEST,
    cacheControl: CACHE_IMMUTABLE_YEAR,
    skipIfExists: true,
  });

  return { version, uploads, verifyKeys: [...manifest.imageKeys], images };
}
