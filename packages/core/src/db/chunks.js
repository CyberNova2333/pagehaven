// 检索库的分块摘要清单（ARCHITECTURE §6 校验层）。
//
// 浏览器端按 chunkSize 对齐取块，每块取回来先比 sha256 再交给 sqlite；整份 sha256 给「整份下载」
// 的退化路径用。清单与 DB 同版本、同域名产出，所以这里只做纯计算：给字节与块大小，得清单。
// 只用 crypto.subtle：构建期（Node）与浏览器端（取块层比对）跑的是同一个函数，输出形式
// （小写 hex）也就必然一致，不存在「两边算法不同」这种只在线上才发现的错。
//
// 清单形状（version 字段给将来改形状留的口子）：
//   { version: 1, totalBytes, chunkSize, sha256: <整份 hex>, chunks: [<第 0 块 hex>, ...] }
// 第 i 块覆盖 [i*chunkSize, min((i+1)*chunkSize, totalBytes)) ，只有最后一块可以短。
import { asUint8 } from './bytes.js';

export const CHUNK_MANIFEST_VERSION = 1;

/**
 * @typedef {object} ChunkManifest
 * @property {1} version
 * @property {number} totalBytes
 * @property {number} chunkSize
 * @property {string} sha256  整份文件的 sha256（小写 hex）
 * @property {string[]} chunks  每块的 sha256（小写 hex），下标 = 块序号
 */

function assertChunkSize(chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new RangeError(`chunkSize 必须是正整数，收到 ${chunkSize}`);
}

function assertTotal(totalBytes) {
  if (!Number.isInteger(totalBytes) || totalBytes < 0) throw new RangeError(`totalBytes 必须是非负整数，收到 ${totalBytes}`);
}

/**
 * 总长为 totalBytes 的文件按 chunkSize 切成几块（最后一块可短；0 字节 = 0 块）。
 * @param {number} totalBytes @param {number} chunkSize
 * @returns {number}
 */
export function chunkCount(totalBytes, chunkSize) {
  assertTotal(totalBytes);
  assertChunkSize(chunkSize);
  return Math.ceil(totalBytes / chunkSize);
}

/**
 * 第 index 块覆盖的字节区间。end 是含端点的——与 HTTP Range 头 `bytes=start-end` 同一语义，
 * 取块层拼请求头时不必再 -1。
 * @param {number} index @param {number} chunkSize @param {number} totalBytes
 * @returns {{start: number, end: number, length: number}}
 */
export function chunkRange(index, chunkSize, totalBytes) {
  const count = chunkCount(totalBytes, chunkSize);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`块序号 ${index} 越界：总长 ${totalBytes} 按 ${chunkSize} 切只有 ${count} 块`);
  }
  const start = index * chunkSize;
  const end = Math.min(start + chunkSize, totalBytes) - 1;
  return { start, end, length: end - start + 1 };
}

/**
 * sha256 → 小写 hex。应当是仓库里唯一的一份实现：取块层比对块摘要用的也是它（从这里 re-export），
 * 清单怎么算、块怎么比就必然是同一个函数，不会出现只在线上才发现的两边算法不同。
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', asUint8(bytes)));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * 给一份完整文件算分块清单。
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {number} chunkSize  取块层的对齐块大小（site.config.yaml 的 db.chunk_size）
 * @returns {Promise<ChunkManifest>}
 */
export async function computeChunkManifest(bytes, chunkSize) {
  const u8 = asUint8(bytes);
  const totalBytes = u8.byteLength;
  const count = chunkCount(totalBytes, chunkSize);
  const chunks = new Array(count);
  for (let i = 0; i < count; i++) {
    const { start, end } = chunkRange(i, chunkSize, totalBytes);
    // subarray 是视图不复制；digest 只读它覆盖的那一段
    chunks[i] = await sha256Hex(u8.subarray(start, end + 1));
  }
  return {
    version: CHUNK_MANIFEST_VERSION,
    totalBytes,
    chunkSize,
    sha256: await sha256Hex(u8),
    chunks,
  };
}
