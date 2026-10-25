// 优先使用站点构建时固定的检索库版本，避免旧页面查询到新版本的数据。
// 未提供 release 的旧调用方仍可读 CDN manifest；每个源都须先通过元数据校验。
// 整份下载仅在预算内可用，读取流时再次限长，最后验 sha256 才交给 sqlite。
import { openGalleryDb, sha256Hex } from '@gallery/core';

export const FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_WHOLE_DOWNLOAD_MAX_BYTES = 30 * 1024 * 1024;

const showHost = (host) => (host.includes('://') ? host : `https://${host}`);

function describeError(e) {
  const code = e?.cause?.code || e?.code;
  if (e?.name === 'TimeoutError') return `超过 ${FETCH_TIMEOUT_MS / 1000} 秒未完成`;
  return code ? `${e.message}（${code}）` : String(e?.message ?? e);
}

async function firstHost(hosts, attempt, signal) {
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

function validateMeta(meta, prefix, maxBytes) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('没有有效的 db 字段：检索库尚未构建');
  const { key, size, sha256 } = meta;
  if (typeof key !== 'string' || !key.startsWith(prefix) || !key.endsWith('.sqlite') ||
      !/^[a-zA-Z0-9_./-]+$/.test(key) || key.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('db.key 必须是检索库前缀下的相对 sqlite 对象路径');
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('db.size 必须是正整数字节数');
  if (typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256)) throw new Error('db.sha256 必须是 64 位十六进制摘要');
  if (size > maxBytes) throw new Error(`检索库 ${size} 字节超过整份下载上限 ${maxBytes} 字节，暂不能加载`);
  return { ...meta, sha256: sha256.toLowerCase() };
}

/** 预分配只发生在可信尺寸已受上限约束后；源多发的字节不再拼接或交给 sqlite。 */
async function download(fetchImpl, url, meta, maxBytes, signal) {
  const controller = new AbortController();
  let reader;
  let res;
  try {
    res = await fetchImpl(url, { signal: requestSignal(signal, controller) });
    if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
    const length = res.headers?.get('content-length');
    if (length !== null && length !== undefined && /^\d+$/.test(length)) {
      const announced = Number(length);
      if (announced > maxBytes) throw new Error(`响应长度 ${announced} 超过整份下载上限 ${maxBytes} 字节`);
      if (announced !== meta.size) throw new Error(`长度 ${announced} 与 manifest 的 ${meta.size} 不符`);
    }
    if (!res.body?.getReader) throw new Error('响应没有可读取的数据流');
    reader = res.body.getReader();
    const bytes = new Uint8Array(meta.size);
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error(`下载超过整份下载上限 ${maxBytes} 字节，已取消`);
      if (received > meta.size) throw new Error(`长度超过 manifest 的 ${meta.size} 字节，已取消`);
      bytes.set(value, received - value.byteLength);
    }
    if (received !== meta.size) throw new Error(`长度 ${received} 与 manifest 的 ${meta.size} 不符（响应截断）`);
    const actual = await sha256Hex(bytes);
    if (actual !== meta.sha256) throw new Error(`sha256 ${actual.slice(0, 12)}… 与 manifest 的 ${meta.sha256.slice(0, 12)}… 不符（字节损坏）`);
    return bytes;
  } catch (e) {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    else await res?.body?.cancel().catch(() => {});
    throw e;
  } finally {
    reader?.releaseLock();
  }
}

/**
 * 返回的 db 由调用方负责 close()。release 存在时只读取该固定版本，null 不回退生产库。
 * @param {{config: object, fetchImpl?: typeof fetch, signal?: AbortSignal}} input
 */
export async function loadGalleryDb({ config, fetchImpl = fetch, signal }) {
  const hosts = (config.images?.hosts ?? []).map(showHost);
  if (hosts.length === 0) throw new Error('site.config.yaml 没有配 images.hosts');
  const settings = config.db ?? {};
  const prefix = settings.prefix ?? '';
  if (!prefix) throw new Error('site.config.yaml 没有配 db.prefix');
  const maxBytes = settings.whole_download_max_bytes ?? DEFAULT_WHOLE_DOWNLOAD_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('整份下载上限必须是非负整数字节数');
  signal?.throwIfAborted();

  let meta;
  if (Object.hasOwn(settings, 'release')) {
    if (settings.release === null) throw new Error('此站点版本的检索库尚未构建');
    meta = validateMeta(settings.release, prefix, maxBytes);
  } else {
    const manifest = await firstHost(hosts, async (host) => {
      const res = await fetchImpl(`${host}/${prefix}manifest.json`, { signal: requestSignal(signal) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      return validateMeta((await res.json())?.db, prefix, maxBytes);
    }, signal);
    meta = manifest.value;
  }

  const fetched = await firstHost(hosts, (host) => download(fetchImpl, `${host}/${meta.key}`, meta, maxBytes, signal), signal);
  signal?.throwIfAborted();
  const db = await openGalleryDb(fetched.value);
  if (signal?.aborted) {
    db.close();
    signal.throwIfAborted();
  }
  return { db, meta, host: fetched.host };
}
