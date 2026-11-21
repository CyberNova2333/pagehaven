// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { openGalleryDb, sha256Hex } from '@gallery/core/db/index';
import { isSafeObjectKey, isSafeObjectPrefix } from '@gallery/core/object-path';

export const FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_WHOLE_DOWNLOAD_MAX_BYTES = 30 * 1024 * 1024;

const showHost = (host) => {
  if (host === '/') return ''; // 本地样本站使用同源相对 URL。
  return host.includes('://') ? host : `https://${host}`;
};

function describeError(e) {
  const code = e?.cause?.code || e?.code;
  if (e?.name === 'TimeoutError') return `超过 ${FETCH_TIMEOUT_MS / 1000} 秒未完成`;
  return code ? `${e.message}（${code}）` : String(e?.message ?? e);
}

export async function firstHost(hosts, attempt, signal) {
  const problems = [];
  for (const host of hosts) {
    signal?.throwIfAborted();
    try {
      return { host, value: await attempt(host) };
    } catch (e) {
      signal?.throwIfAborted();
      problems.push(`${host}：${describeError(e)}`);
    }
  }
  throw new Error(`所有图片域名都取不到（${problems.join('；')}）`);
}

function requestSignal(signal, controller) {
  return AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : []), ...(controller ? [controller.signal] : [])]);
}

function validateMeta(meta, prefix, maxBytes, { allowLargeWithChunks = false } = {}) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('没有有效的 db 字段：检索库尚未构建');
  const { key, size, sha256, chunks, chunkSize, pageSize } = meta;
  if (!isSafeObjectKey(key) || !key.startsWith(prefix) || !key.endsWith('.sqlite')) {
    throw new Error('db.key 必须是检索库前缀下的相对 sqlite 对象路径');
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('db.size 必须是正整数字节数');
  if (typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256)) throw new Error('db.sha256 必须是 64 位十六进制摘要');
  if (chunks !== undefined && chunks !== null) {
    if (!isSafeObjectKey(chunks) || !chunks.startsWith(prefix) || !chunks.endsWith('.chunks.json')) {
      throw new Error('db.chunks 必须是检索库前缀下的相对 chunks.json 对象路径');
    }
  }
  if (chunkSize !== undefined && chunkSize !== null && (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)) {
    throw new Error('db.chunkSize 必须是正整数字节数');
  }
  if (pageSize !== undefined && pageSize !== null && (!Number.isSafeInteger(pageSize) || pageSize <= 0)) {
    throw new Error('db.pageSize 必须是正整数字节数');
  }
  if (meta.chunksSha256 !== undefined && (typeof meta.chunksSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(meta.chunksSha256))) {
    throw new Error('db.chunksSha256 必须是分块清单的 SHA-256 摘要');
  }
  const hasChunks = Boolean(chunks && meta.chunksSha256);
  if (size > maxBytes && !(allowLargeWithChunks && hasChunks)) {
    throw new Error(`检索库 ${size} 字节超过整份下载上限 ${maxBytes} 字节，暂不能加载`);
  }
  return { ...meta, sha256: sha256.toLowerCase() };
}

/**
 * 带流长度与上限保护的受控下载：同时给整库下载（exactLength）与 `.chunks.json` 清单使用。
 */
export async function readBoundedResponse(fetchImpl, url, { maxBytes, exactLength = null, signal, overflowLabel = '整份下载上限' }) {
  const controller = new AbortController();
  let reader;
  let res;
  try {
    res = await fetchImpl(url, { signal: requestSignal(signal, controller) });
    if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
    const length = res.headers?.get('content-length');
    if (length !== null && length !== undefined && /^\d+$/.test(length)) {
      const announced = Number(length);
      if (announced > maxBytes) throw new Error(`响应长度 ${announced} 超过${overflowLabel} ${maxBytes} 字节`);
      if (exactLength !== null && announced !== exactLength) throw new Error(`长度 ${announced} 与 manifest 的 ${exactLength} 不符`);
    }
    if (!res.body?.getReader) throw new Error('响应没有可读取的数据流');
    reader = res.body.getReader();
    const bytes = exactLength === null ? null : new Uint8Array(exactLength);
    const parts = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = received + value.byteLength;
      if (next > maxBytes) throw new Error(`下载超过${overflowLabel} ${maxBytes} 字节，已取消`);
      if (bytes) {
        if (next > exactLength) throw new Error(`长度超过 manifest 的 ${exactLength} 字节，已取消`);
        bytes.set(value, received);
      } else {
        parts.push(value);
      }
      received = next;
    }
    if (bytes) {
      if (received !== exactLength) throw new Error(`长度 ${received} 与 manifest 的 ${exactLength} 不符（响应截断）`);
      return bytes;
    }
    const out = new Uint8Array(received);
    let pos = 0;
    for (const part of parts) {
      out.set(part, pos);
      pos += part.byteLength;
    }
    return out;
  } catch (e) {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    else await res?.body?.cancel().catch(() => {});
    throw e;
  } finally {
    reader?.releaseLock();
  }
}

/** 预分配只发生在可信尺寸已受上限约束后；源多发的字节不再拼接或交给 sqlite。 */
async function downloadWhole(fetchImpl, url, meta, maxBytes, signal) {
  const bytes = await readBoundedResponse(fetchImpl, url, { maxBytes, exactLength: meta.size, signal });
  const actual = await sha256Hex(bytes);
  if (actual !== meta.sha256) throw new Error(`sha256 ${actual.slice(0, 12)}… 与 manifest 的 ${meta.sha256.slice(0, 12)}… 不符（字节损坏）`);
  return bytes;
}

function validateSettings(config) {
  const hosts = (config.images?.hosts ?? []).map(showHost);
  if (hosts.length === 0) throw new Error('site.config.yaml 没有配 images.hosts');
  const settings = config.db ?? {};
  const prefix = settings.prefix ?? '';
  if (!prefix) throw new Error('site.config.yaml 没有配 db.prefix');
  if (!isSafeObjectPrefix(prefix)) throw new Error('db.prefix 必须是以 / 结尾且没有空段或点段的 ASCII 相对对象前缀');
  const maxBytes = settings.whole_download_max_bytes ?? DEFAULT_WHOLE_DOWNLOAD_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('整份下载上限必须是非负整数字节数');
  return { hosts, settings, prefix, maxBytes };
}

export async function resolveDbConfig({ config, fetchImpl = fetch, signal, allowLargeWithChunks = false } = {}) {
  const { hosts, settings, prefix, maxBytes } = validateSettings(config);
  signal?.throwIfAborted();

  let meta;
  if (Object.hasOwn(settings, 'release')) {
    if (settings.release === null) throw new Error('此站点版本的检索库尚未构建');
    meta = validateMeta(settings.release, prefix, maxBytes, { allowLargeWithChunks });
  } else {
    const manifest = await firstHost(hosts, async (host) => {
      const res = await fetchImpl(`${host}/${prefix}manifest.json`, { signal: requestSignal(signal) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      return validateMeta((await res.json())?.db, prefix, maxBytes, { allowLargeWithChunks });
    }, signal);
    meta = manifest.value;
  }
  return { hosts, prefix, maxBytes, meta };
}

export async function openWholeDb({ hosts, meta, maxBytes }, fetchImpl, signal) {
  if (meta.size > maxBytes) throw new Error(`检索库 ${meta.size} 字节超过整份下载上限 ${maxBytes} 字节`);
  const fetched = await firstHost(hosts, (host) => downloadWhole(fetchImpl, `${host}/${meta.key}`, meta, maxBytes, signal), signal);
  signal?.throwIfAborted();
  const db = await openGalleryDb(fetched.value);
  if (signal?.aborted) {
    db.close();
    signal.throwIfAborted();
  }
  return { db, meta, host: fetched.host, mode: 'whole' };
}

export async function loadWholeDb({ config, fetchImpl = fetch, signal }) {
  const resolved = await resolveDbConfig({ config, fetchImpl, signal });
  return openWholeDb(resolved, fetchImpl, signal);
}
