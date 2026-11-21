// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 分块文件：探测 / 取块 / 校验 / 多源 / 退化的组装（ARCHITECTURE §6）。
//
// 这层只认一个 manifest（总长、块大小、整份 sha256、逐块 sha256），与 sqlite 无关：检索端的 VFS
// 把 read(offset, length) 接上就行，阅读器的图片加载共用同一套多源与探测逻辑。
// 校验通过才进缓存、进缓存才交出去——CDN 回错字节、缓存串台、截断在这里被抓住，不会变成
// `database disk image is malformed`。
import { probe } from './probe.js';
import { fetchRange, fetchWhole } from './range.js';
import { SourceSet } from './sources.js';
import { sha256Hex } from './digest.js';
import { ChunkFetchError } from './errors.js';
import { abortReason, now, sleep, SharedJob } from './support.js';
import {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_CHUNKS,
  ChunkCache,
  advanceChunkRetry,
  asChunkError,
  chunkRangeFor,
  describeSources,
  giveUpError,
  needsWholeError,
  normalizeManifest,
  normalizeRetry,
  pickRangeSource,
  refreshNeedsWhole,
  stitchChunks,
  validateReadWindow,
} from './session.js';

export { DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, DEFAULT_CACHE_CHUNKS };

export class ChunkedFile {
  #sources;
  #manifest;
  #chunkCount;
  #retry;
  #fetch;
  #timeoutMs;
  #onSourceSwitch;
  #onChunkVerifyFailed;
  #onProgress;
  #cache;
  /** @type {Map<number, SharedJob<Uint8Array>>} */
  #inflight = new Map();
  /** @type {SharedJob<object>|null} */
  #probing = null;
  #needsWhole = false;

  constructor({
    sources,
    manifest,
    cacheChunks = DEFAULT_CACHE_CHUNKS,
    retry = {},
    fetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onSourceSwitch,
    onChunkVerifyFailed,
    onProgress,
  } = {}) {
    if (!(sources instanceof SourceSet)) throw new TypeError('sources 必须是 SourceSet');
    if (typeof fetch !== 'function') throw new TypeError('fetch 必须是函数');
    this.#sources = sources;
    this.#manifest = normalizeManifest(manifest);
    this.#chunkCount = this.#manifest.chunks.length;
    this.#cache = new ChunkCache(cacheChunks);
    this.#retry = normalizeRetry(retry, sources);
    // 存起来的 fetch 永远以局部变量的方式调用，不写 this.#fetch(...)：浏览器里的 fetch 对 this 挑剔，
    // 挂在别的对象上调用会抛 Illegal invocation
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
    this.#onSourceSwitch = onSourceSwitch;
    this.#onChunkVerifyFailed = onChunkVerifyFailed;
    this.#onProgress = onProgress;
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

  probeAll({ signal, verifyRange = false } = {}) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const job = new SharedJob((jobSignal) => this.#probeAll(jobSignal, verifyRange));
    this.#probing = job;
    job.promise.catch(() => {
      if (this.#probing === job) this.#probing = null;
    });
    return job.join(signal);
  }

  #ensureProbed(signal) {
    const job = this.#probing;
    if (job && !job.abandoned) return job.join(signal);
    return this.probeAll({ signal });
  }

  #refreshNeedsWhole() {
    this.#needsWhole = refreshNeedsWhole(this.#sources);
    return this.#needsWhole;
  }

  async #probeAll(signal, verifyRange) {
    const doFetch = this.#fetch;
    const total = this.#manifest.totalBytes;
    const results = {};
    await Promise.all(
      this.#sources.ids.map(async (id) => {
        let r;
        try {
          r = await probe(this.#sources.urlOf(id), { fetch: doFetch, signal, timeoutMs: this.#timeoutMs, verifyRange });
        } catch (e) {
          if (signal?.aborted) throw e;
          this.#sources.disable(id, `探测失败：${e?.code ?? e?.message ?? e}`);
          results[id] = { error: e };
          return;
        }
        this.#sources.enable(id);
        this.#sources.setProbeResult(id, r);
        results[id] = r;
        if (r.total !== null && r.total !== total) {
          this.#sources.disable(id, `尺寸不一致：源上 ${r.total} 字节，manifest ${total} 字节（多半是旧版本文件）`);
        }
      }),
    );
    if (this.#sources.allStats().every((s) => s.disabled)) {
      throw new ChunkFetchError('no-usable-source', `没有可用的源：${describeSources(this.#sources, new Map())}`, { results });
    }
    return { needsWhole: this.#refreshNeedsWhole(), results };
  }

  readChunk(index, { signal } = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#chunkCount) {
      return Promise.reject(new RangeError(`块号 ${index} 越界（共 ${this.#chunkCount} 块）`));
    }
    const hit = this.#cache.get(index);
    if (hit) return Promise.resolve(hit);
    const pending = this.#inflight.get(index);
    if (pending && !pending.abandoned) return pending.join(signal);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const job = new SharedJob((jobSignal) => this.#fetchChunk(index, jobSignal));
    this.#inflight.set(index, job);
    const cleanup = () => {
      if (this.#inflight.get(index) === job) this.#inflight.delete(index);
    };
    job.promise.then(cleanup, cleanup);
    return job.join(signal);
  }

  async #fetchChunk(index, signal) {
    await this.#ensureProbed(signal);
    if (this.#needsWhole) throw needsWholeError(this.#sources, index, new Map());
    const doFetch = this.#fetch;
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
          throw this.#refreshNeedsWhole()
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
        bytes = await fetchRange(this.#sources.urlOf(current), start, end, {
          fetch: doFetch,
          signal,
          timeoutMs: this.#timeoutMs,
        });
        const hash = await sha256Hex(bytes);
        if (hash !== expectedHash) {
          error = new ChunkFetchError('checksum', `块 #${index} 从 ${current} 取到的字节 sha256 不符`, {
            chunk: index,
            source: current,
            expected: expectedHash,
            actual: hash,
          });
        }
      } catch (e) {
        if (signal?.aborted) {
          this.#sources.onCancel(current);
          throw e;
        }
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
        await sleep(step.delayMs, signal);
        spentMs += step.delayMs;
      }
    }
  }

  async read(offset, length, { signal } = {}) {
    validateReadWindow(offset, length, this.#manifest.totalBytes);
    if (length === 0) return new Uint8Array(0);
    const { chunkSize } = this.#manifest;
    const first = Math.floor(offset / chunkSize);
    const last = Math.floor((offset + length - 1) / chunkSize);
    const chunks = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => this.readChunk(first + i, { signal })));
    return stitchChunks(chunks, first, chunkSize, offset, length);
  }

  async downloadWhole({ signal } = {}) {
    await this.#ensureProbed(signal);
    const doFetch = this.#fetch;
    const total = this.#manifest.totalBytes;
    const failures = new Map();
    const excluded = new Set();
    let previous = null;
    for (let attempt = 0; attempt < this.#retry.maxAttempts; attempt++) {
      const id = this.#sources.pick({ exclude: excluded });
      if (id === null) break;
      if (previous !== null) this.#onSourceSwitch?.({ from: previous, to: id, chunk: null, why: failures.get(previous).at(-1) });
      const t0 = now();
      this.#sources.onStart(id);
      try {
        const bytes = await fetchWhole(this.#sources.urlOf(id), total, {
          fetch: doFetch,
          signal,
          timeoutMs: this.#timeoutMs,
          onBytes: (received) => this.#onProgress?.({ kind: 'whole', source: id, received, total }),
        });
        const hash = await sha256Hex(bytes);
        if (hash !== this.#manifest.sha256) {
          throw new ChunkFetchError('checksum', `从 ${id} 整份下载的文件 sha256 不符`, {
            source: id,
            expected: this.#manifest.sha256,
            actual: hash,
          });
        }
        this.#sources.onSuccess(id, bytes.length, now() - t0);
        return bytes;
      } catch (e) {
        if (signal?.aborted) {
          this.#sources.onCancel(id);
          throw e;
        }
        const error = asChunkError(e);
        this.#sources.onFailure(id, error.code);
        if (error.code === 'checksum') this.#onChunkVerifyFailed?.({ chunk: null, source: id });
        if (!failures.has(id)) failures.set(id, []);
        failures.get(id).push(error.code);
        excluded.add(id);
        previous = id;
      }
    }
    throw new ChunkFetchError('exhausted', `整份下载失败：${describeSources(this.#sources, failures)}`, {
      failures: Object.fromEntries(failures),
    });
  }
}
