// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 专供 sqlite3_vfs 同步 xRead 调用的分块读取器：共用 SourceSet、ChunkManifest、LRU 缓存、
// 多源切源与逐块 SHA-256 校验，在 Dedicated Worker 内以同步 XHR 或注入的同步传输函数取块。
import { fetchRangeSync } from './range.js';
import { SourceSet } from './sources.js';
import { sha256HexSync } from './digest.js';
import { ChunkFetchError } from './errors.js';
import { now } from './support.js';
import {
  DEFAULT_CACHE_CHUNKS,
  DEFAULT_TIMEOUT_MS,
  ChunkCache,
  advanceChunkRetry,
  asChunkError,
  chunkRangeFor,
  giveUpError,
  needsWholeError,
  normalizeManifest,
  normalizeRetry,
  pickRangeSource,
  refreshNeedsWhole,
  stitchChunks,
  validateReadWindow,
} from './session.js';

export class SyncChunkedFile {
  #sources;
  #manifest;
  #chunkCount;
  #retry;
  #readRangeSync;
  #sleepSync;
  #timeoutMs;
  #onSourceSwitch;
  #onChunkVerifyFailed;
  #onProgress;
  #cache;
  #needsWhole = false;

  constructor({
    sources,
    manifest,
    cacheChunks = DEFAULT_CACHE_CHUNKS,
    retry = {},
    readRangeSync = fetchRangeSync,
    sleepSync = () => {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onSourceSwitch,
    onChunkVerifyFailed,
    onProgress,
  } = {}) {
    if (!(sources instanceof SourceSet)) throw new TypeError('sources 必须是 SourceSet');
    if (typeof readRangeSync !== 'function') throw new TypeError('readRangeSync 必须是同步函数');
    this.#sources = sources;
    this.#manifest = normalizeManifest(manifest);
    this.#chunkCount = this.#manifest.chunks.length;
    this.#cache = new ChunkCache(cacheChunks);
    this.#retry = normalizeRetry(retry, sources);
    this.#readRangeSync = readRangeSync;
    this.#sleepSync = sleepSync;
    this.#timeoutMs = timeoutMs;
    this.#onSourceSwitch = onSourceSwitch;
    this.#onChunkVerifyFailed = onChunkVerifyFailed;
    this.#onProgress = onProgress;
    this.#needsWhole = refreshNeedsWhole(this.#sources);
  }

  get manifest() {
    return this.#manifest;
  }

  get chunkCount() {
    return this.#chunkCount;
  }

  get needsWhole() {
    return this.#needsWhole;
  }

  get sources() {
    return this.#sources;
  }

  chunkRange(index) {
    return chunkRangeFor(this.#manifest, this.#chunkCount, index);
  }

  /**
   * 同步读取并验证第 index 块。只有逐块 SHA-256 与 manifest 完全一致才进缓存并返回。
   * @param {number} index
   * @returns {Uint8Array}
   */
  readChunk(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#chunkCount) {
      throw new RangeError(`块号 ${index} 越界（共 ${this.#chunkCount} 块）`);
    }
    const hit = this.#cache.get(index);
    if (hit) return hit;
    if (this.#needsWhole) throw needsWholeError(this.#sources, index, new Map());

    const { start, end } = this.chunkRange(index);
    const expectedHash = this.#manifest.chunks[index];
    const failures = new Map();
    const excluded = new Set();
    let attempts = 0;
    let spentMs = 0;
    let streak = 0;
    let current = null;

    for (;;) {
      if (current === null) {
        current = pickRangeSource(this.#sources, excluded);
        if (current === null && excluded.size > 0) {
          excluded.clear();
          current = pickRangeSource(this.#sources, excluded);
        }
        if (current === null) {
          this.#needsWhole = refreshNeedsWhole(this.#sources);
          throw this.#needsWhole
            ? needsWholeError(this.#sources, index, failures)
            : giveUpError(this.#sources, this.#manifest, this.#chunkCount, index, attempts, spentMs, failures);
        }
        streak = 0;
      }

      const t0 = now();
      this.#sources.onStart(current);
      let bytes = null;
      let error = null;
      try {
        bytes = this.#readRangeSync(this.#sources.urlOf(current), start, end, { timeoutMs: this.#timeoutMs });
        const hash = sha256HexSync(bytes);
        if (hash !== expectedHash) {
          error = new ChunkFetchError('checksum', `块 #${index} 从 ${current} 取到的字节 sha256 不符`, {
            chunk: index,
            source: current,
            expected: expectedHash,
            actual: hash,
          });
        }
      } catch (e) {
        error = asChunkError(e);
      }
      const ms = now() - t0;

      if (error === null) {
        this.#sources.onSuccess(current, bytes.length, ms);
        this.#cache.set(index, bytes);
        this.#onProgress?.({ kind: 'chunk', chunk: index, source: current, bytes: bytes.length, ms, attempts: attempts + 1 });
        return bytes;
      }

      attempts += 1;
      spentMs += ms;
      streak += 1;
      const step = advanceChunkRetry({
        sources: this.#sources,
        manifest: this.#manifest,
        chunkCount: this.#chunkCount,
        index,
        current,
        excluded,
        failures,
        error,
        attempts,
        spentMs,
        streak,
        retry: this.#retry,
        onChunkVerifyFailed: this.#onChunkVerifyFailed,
        onSourceSwitch: this.#onSourceSwitch,
      });
      if (step.needsWhole) this.#needsWhole = true;
      if (step.action === 'throw') throw step.error;
      current = step.current;
      streak = step.streak;
      if (step.action === 'backoff') {
        const sleepStart = now();
        this.#sleepSync(step.delayMs);
        spentMs += now() - sleepStart;
      }
    }
  }

  /**
   * 同步读取任意字节区间 [offset, offset + length)。
   * @param {number} offset
   * @param {number} length
   * @returns {Uint8Array}
   */
  read(offset, length) {
    validateReadWindow(offset, length, this.#manifest.totalBytes);
    if (length === 0) return new Uint8Array(0);
    const { chunkSize } = this.#manifest;
    const first = Math.floor(offset / chunkSize);
    const last = Math.floor((offset + length - 1) / chunkSize);
    const chunks = [];
    for (let i = first; i <= last; i++) chunks.push(this.readChunk(i));
    return stitchChunks(chunks, first, chunkSize, offset, length);
  }
}
