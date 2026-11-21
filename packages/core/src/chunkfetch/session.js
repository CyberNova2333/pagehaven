// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 异步（ChunkedFile）与同步（SyncChunkedFile）分块读取器共用的清单校验、LRU 缓存、
// 多源失败描述与重试切换决策。把状态迁移收在一处，避免两套取块器慢慢分叉。
import { ChunkFetchError, SWITCH_IMMEDIATELY } from './errors.js';

export const DEFAULT_RETRY = Object.freeze({ maxAttempts: 6, baseDelayMs: 200, maxDelayMs: 2000, budgetMs: 60000 });
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_CACHE_CHUNKS = 64;

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** @param {unknown} m */
export function normalizeManifest(m) {
  if (!m || typeof m !== 'object') throw new TypeError('manifest 必须是对象');
  const { totalBytes, chunkSize, sha256, chunks } = m;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new TypeError('manifest.totalBytes 必须是非负整数');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('manifest.chunkSize 必须是正整数');
  if (typeof sha256 !== 'string' || !HEX_SHA256.test(sha256)) throw new TypeError('manifest.sha256 必须是 64 位 hex');
  const expectedCount = Math.ceil(totalBytes / chunkSize);
  if (!Array.isArray(chunks) || chunks.length !== expectedCount) {
    throw new TypeError(`manifest.chunks 应有 ${expectedCount} 项（totalBytes ${totalBytes} / chunkSize ${chunkSize}），实际 ${chunks?.length}`);
  }
  for (const [i, h] of chunks.entries()) {
    if (typeof h !== 'string' || !HEX_SHA256.test(h)) throw new TypeError(`manifest.chunks[${i}] 不是 64 位 hex`);
  }
  return { totalBytes, chunkSize, sha256: sha256.toLowerCase(), chunks: chunks.map((h) => h.toLowerCase()) };
}

export function normalizeRetry(retry, sources) {
  const maxAttempts = retry.maxAttempts ?? Math.max(DEFAULT_RETRY.maxAttempts, sources.ids.length * sources.maxConsecutiveFailures);
  const resolved = { ...DEFAULT_RETRY, ...retry, maxAttempts };
  for (const k of Object.keys(DEFAULT_RETRY)) {
    if (!(typeof resolved[k] === 'number' && resolved[k] >= 0)) throw new TypeError(`retry.${k} 必须是非负数`);
  }
  return resolved;
}

export function chunkRangeFor(manifest, chunkCount, index) {
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
    throw new RangeError(`块号 ${index} 越界（共 ${chunkCount} 块）`);
  }
  const { chunkSize, totalBytes } = manifest;
  const start = index * chunkSize;
  const end = Math.min(totalBytes, start + chunkSize) - 1;
  return { start, end, length: end - start + 1 };
}

export class ChunkCache {
  #limit;
  /** @type {Map<number, Uint8Array>} 插入顺序即 LRU 顺序 */
  #map = new Map();

  constructor(limit = DEFAULT_CACHE_CHUNKS) {
    this.#limit = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_CACHE_CHUNKS;
  }

  get(index) {
    const hit = this.#map.get(index);
    if (!hit) return undefined;
    this.#map.delete(index);
    this.#map.set(index, hit);
    return hit;
  }

  set(index, bytes) {
    if (this.#limit <= 0) return;
    this.#map.set(index, bytes);
    while (this.#map.size > this.#limit) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
  }
}

/** @param {unknown} e @returns {ChunkFetchError} */
export function asChunkError(e) {
  if (e instanceof ChunkFetchError) return e;
  return new ChunkFetchError('network', e instanceof Error ? e.message : String(e), { cause: e });
}

/** ['timeout','timeout','http-500'] → 'timeout ×2, http-500'：给人看的失败摘要，连续重复折叠。 */
function summarize(reasons) {
  const parts = [];
  for (const r of reasons) {
    const last = parts[parts.length - 1];
    if (last && last.code === r) last.n += 1;
    else parts.push({ code: r, n: 1 });
  }
  return parts.map((p) => (p.n > 1 ? `${p.code} ×${p.n}` : p.code)).join(', ');
}

export function describeSources(sources, failures) {
  return sources
    .allStats()
    .map((s) => {
      const reasons = failures.get(s.id);
      if (reasons?.length) return `${s.id}：${summarize(reasons)}`;
      if (s.disabled) return `${s.id}：已禁用（${s.disabledReason}）`;
      if (s.rangeSupported === false) return `${s.id}：不支持 Range，未尝试`;
      return `${s.id}：未尝试`;
    })
    .join('；');
}

export function needsWholeError(sources, index, failures) {
  const who = failures.size > 0 ? `（${describeSources(sources, failures)}）` : '';
  return new ChunkFetchError('needs-whole', `所有源都不支持 Range，请改用 downloadWhole()${who}`, {
    chunk: index,
    failures: Object.fromEntries(failures),
  });
}

export function giveUpError(sources, manifest, chunkCount, index, attempts, spentMs, failures) {
  const { start, end } = chunkRangeFor(manifest, chunkCount, index);
  return new ChunkFetchError(
    'exhausted',
    `块 #${index}（字节 ${start}–${end}）在 ${attempts} 次尝试、失败耗时 ${Math.round(spentMs)} ms 后放弃：${describeSources(sources, failures)}`,
    { chunk: index, attempts, spentMs, failures: Object.fromEntries(failures) },
  );
}

export function refreshNeedsWhole(sources) {
  const usable = sources.allStats().filter((s) => !s.disabled);
  return usable.length > 0 && usable.every((s) => s.rangeSupported === false);
}

export function pickRangeSource(sources, excluded) {
  return sources.pick({ exclude: excluded, filter: (s) => s.rangeSupported !== false });
}

/**
 * 统一记录一次块失败、更新源状态、决定是立刻切源还是原地退避、以及何时放弃或宣布 needs-whole。
 */
export function advanceChunkRetry({
  sources,
  manifest,
  chunkCount,
  index,
  current,
  excluded,
  failures,
  error,
  attempts,
  spentMs,
  streak,
  retry,
  onChunkVerifyFailed,
  onSourceSwitch,
}) {
  sources.onFailure(current, error.code);
  if (error.code === 'checksum') onChunkVerifyFailed?.({ chunk: index, source: current });
  if (!failures.has(current)) failures.set(current, []);
  failures.get(current).push(error.code);

  let needsWhole = false;
  if (error.code === 'range-ignored') {
    sources.setRangeSupported(current, false);
    needsWhole = refreshNeedsWhole(sources);
    if (needsWhole) {
      return { action: 'throw', needsWhole: true, error: needsWholeError(sources, index, failures) };
    }
  }

  if (attempts >= retry.maxAttempts || spentMs >= retry.budgetMs) {
    return {
      action: 'throw',
      needsWhole,
      error: giveUpError(sources, manifest, chunkCount, index, attempts, spentMs, failures),
    };
  }

  let nextCurrent = current;
  let nextStreak = streak;
  const mustSwitch =
    SWITCH_IMMEDIATELY.has(error.code) ||
    streak >= sources.maxConsecutiveFailures ||
    sources.stats(current).consecutiveFailures >= sources.maxConsecutiveFailures;
  if (mustSwitch) {
    excluded.add(current);
    const next = pickRangeSource(sources, excluded);
    if (next !== null) {
      onSourceSwitch?.({ from: current, to: next, chunk: index, why: error.code });
      return { action: 'continue', current: next, streak: 0, delayMs: 0 };
    }
    if (sources.stats(current).rangeSupported === false || sources.stats(current).disabled) nextCurrent = null;
  }

  const delayMs = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** Math.max(0, nextStreak - 1));
  if (spentMs + delayMs >= retry.budgetMs) {
    return {
      action: 'throw',
      needsWhole,
      error: giveUpError(sources, manifest, chunkCount, index, attempts, spentMs, failures),
    };
  }
  return { action: 'backoff', current: nextCurrent, streak: nextStreak, delayMs };
}

/** 从已校验的块数组拼接出任意字节切片 [offset, offset + length)。 */
export function stitchChunks(chunks, firstChunkIndex, chunkSize, offset, length) {
  const out = new Uint8Array(length);
  if (length === 0) return out;
  let pos = 0;
  for (let i = firstChunkIndex; i < firstChunkIndex + chunks.length; i++) {
    const chunk = chunks[i - firstChunkIndex];
    const chunkStart = i * chunkSize;
    const from = Math.max(offset, chunkStart) - chunkStart;
    const to = Math.min(offset + length, chunkStart + chunk.length) - chunkStart;
    out.set(chunk.subarray(from, to), pos);
    pos += to - from;
  }
  return out;
}

export function validateReadWindow(offset, length, totalBytes) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > totalBytes) {
    throw new RangeError(`读取区间 [${offset}, ${offset + length}) 越界（文件 ${totalBytes} 字节）`);
  }
}
