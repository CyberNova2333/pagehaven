// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 只在分块清单的摘要随页面固定后启用 Range。旧发布沿用整库摘要和下载预算。
import { CHUNK_MANIFEST_VERSION, ChunkedFile, SourceSet, SyncChunkedFile, normalizeChunkManifest, openChunkedGalleryDb, sha256Hex } from '@gallery/core';
import { FETCH_TIMEOUT_MS, firstHost, openWholeDb, readBoundedResponse, resolveDbConfig } from './whole.js';
export { FETCH_TIMEOUT_MS, DEFAULT_WHOLE_DOWNLOAD_MAX_BYTES } from './whole.js';

const DEFAULT_CHUNKS_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_RANGE_CACHE_CHUNKS = 128;

async function fetchChunksManifest({ hosts, meta, fetchImpl = fetch, signal, maxBytes = DEFAULT_CHUNKS_MANIFEST_MAX_BYTES }) {
  const res = await firstHost(hosts, async (host) => {
    const raw = await readBoundedResponse(fetchImpl, `${host}/${meta.chunks}`, {
      maxBytes,
      signal,
      overflowLabel: '分块清单大小上限',
    });
    if (await sha256Hex(raw) !== meta.chunksSha256) throw new Error('分块清单 SHA-256 与发布清单不符');
    const json = JSON.parse(new TextDecoder().decode(raw));
    if (json.version !== CHUNK_MANIFEST_VERSION) throw new Error('不支持的分块清单版本');
    const parsed = normalizeChunkManifest(json);
    if (parsed.totalBytes !== meta.size) {
      throw new Error(`chunks.json totalBytes (${parsed.totalBytes}) 与 manifest size (${meta.size}) 不符`);
    }
    if (parsed.sha256 !== meta.sha256) {
      throw new Error(`chunks.json sha256 (${parsed.sha256.slice(0, 12)}…) 与 manifest 不符`);
    }
    if (meta.chunkSize && parsed.chunkSize !== meta.chunkSize) {
      throw new Error(`chunks.json chunkSize (${parsed.chunkSize}) 与 manifest (${meta.chunkSize}) 不符`);
    }
    return parsed;
  }, signal);
  return res.value;
}

/**
 * 返回的 db 由调用方负责 close()。release 存在时只读取该固定版本，null 不回退生产库。
 * 提供 readRangeSync 且 manifest 含 chunks 时，优先通过 @gallery/core/chunkfetch + SQLite Range VFS 加载，
 * 仅在所有源都无视 Range 时按 whole_download_max_bytes 预算自动退化回整份下载。
 * @param {{config: object, fetchImpl?: typeof fetch, readRangeSync?: Function, sleepSync?: Function,
 *   cacheChunks?: number, timeoutMs?: number, signal?: AbortSignal}} input
 */
export async function loadGalleryDb({
  config,
  fetchImpl = fetch,
  readRangeSync,
  sleepSync,
  cacheChunks = DEFAULT_RANGE_CACHE_CHUNKS,
  timeoutMs = FETCH_TIMEOUT_MS,
  signal,
}) {
  const resolved = await resolveDbConfig({ config, fetchImpl, signal, allowLargeWithChunks: Boolean(readRangeSync) });
  const { hosts, meta } = resolved;
  const fallbackWhole = () => openWholeDb(resolved, fetchImpl, signal);
  if (!readRangeSync || !meta.chunks || !meta.chunksSha256) return fallbackWhole();

  const manifest = await fetchChunksManifest({ hosts, meta, fetchImpl, signal });
  const sources = new SourceSet(hosts.map((host, i) => ({ id: String(i), url: `${host}/${meta.key}` })));
  const probeFile = new ChunkedFile({ sources, manifest, fetch: fetchImpl, timeoutMs });
  const summary = await probeFile.probeAll({ signal, verifyRange: true });
  if (summary.needsWhole) return fallbackWhole();

  const reader = new SyncChunkedFile({ sources, manifest, cacheChunks, readRangeSync, sleepSync, timeoutMs });
  try {
    const db = await openChunkedGalleryDb({
      readSync: (offset, length) => reader.read(offset, length),
      totalBytes: manifest.totalBytes,
      sectorSize: meta.pageSize ?? config.db?.page_size ?? 4096,
    });
    if (signal?.aborted) {
      db.close();
      signal.throwIfAborted();
    }
    const source = sources.allStats().find((s) => s.samples > 0 && !s.disabled);
    return { db, meta, host: source ? hosts[Number(source.id)] : hosts[0], mode: 'range', fallbackWhole };
  } catch (error) {
    if (error.code === 'needs-whole') return fallbackWhole();
    throw error;
  }
}
