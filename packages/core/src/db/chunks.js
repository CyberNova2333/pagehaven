// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 检索库的分块摘要清单（ARCHITECTURE §6 校验层）。
//
// 浏览器端按 chunkSize 对齐取块，每块取回来先比 sha256 再交给 sqlite；整份 sha256 给「整份下载」
// 的退化路径用。清单与 DB 同版本、同域名产出，所以这里只做纯计算：给字节与块大小，得清单。
// 构建端走 Web Crypto crypto.subtle；Worker 内同步 sqlite3_vfs 走同一文件里的纯 JS 同步
// sha256HexSync，两者的测试对同一批边界向量做逐字节对账，确保不会出现两边摘要不一致。
//
// 清单形状（version 字段给将来改形状留的口子）：
//   { version: 1, totalBytes, chunkSize, sha256: <整份 hex>, chunks: [<第 0 块 hex>, ...] }
// 第 i 块覆盖 [i*chunkSize, min((i+1)*chunkSize, totalBytes)) ，只有最后一块可以短。
import { asUint8 } from './bytes.js';

export const CHUNK_MANIFEST_VERSION = 1;

const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

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
 * sha256 → 小写 hex（Web Crypto 异步版）。
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
 * 同步版 sha256 → 小写 hex，供 sqlite3_vfs 的同步 xRead（无 COOP/COEP 的 Worker）逐块验摘要。
 * 实现遵循 FIPS 180-4，并在测试中与 Web Crypto 及 node:crypto 对账。
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {string}
 */
export function sha256HexSync(bytes) {
  const u8 = asUint8(bytes);
  const len = u8.byteLength;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const block = new Uint8Array(paddedLen);
  block.set(u8);
  block[len] = 0x80;
  const bitLen = len * 8;
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  block[paddedLen - 8] = (hiBits >>> 24) & 0xff;
  block[paddedLen - 7] = (hiBits >>> 16) & 0xff;
  block[paddedLen - 6] = (hiBits >>> 8) & 0xff;
  block[paddedLen - 5] = hiBits & 0xff;
  block[paddedLen - 4] = (loBits >>> 24) & 0xff;
  block[paddedLen - 3] = (loBits >>> 16) & 0xff;
  block[paddedLen - 2] = (loBits >>> 8) & 0xff;
  block[paddedLen - 1] = loBits & 0xff;

  let h0 = SHA256_H0[0];
  let h1 = SHA256_H0[1];
  let h2 = SHA256_H0[2];
  let h3 = SHA256_H0[3];
  let h4 = SHA256_H0[4];
  let h5 = SHA256_H0[5];
  let h6 = SHA256_H0[6];
  let h7 = SHA256_H0[7];
  const w = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4;
      w[i] = ((block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = [h0, h1, h2, h3, h4, h5, h6, h7];
  let hex = '';
  for (let i = 0; i < 8; i++) hex += out[i].toString(16).padStart(8, '0');
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
