// 检索库加载：从 CDN 读 db/manifest.json 拿当前版本，再整份下载并校验，交给 core 的 openGalleryDb。
//
// 走的是 ARCHITECTURE §6 的退化路径：库总长在 whole_download_max_bytes（30 MB）以内时整份下载、
// 验整份 sha256、载入内存。分块 Range 读取（取块层）是后续优化——它要自定义 sqlite 的同步 VFS，
// 浏览器里只能靠 Worker + 同步 XHR，先把「能查、查得对、坏了能看出坏」落地。
//
// 所有读取都经 CDN 域名（铁律 7）：浏览器不知道对象存储的存在，也不该知道。
// 两个源（images.hosts 可以有两个）按顺序尝试；整份 sha256 校验兜住 CDN 回错字节、截断与缓存串台。

import { openGalleryDb, sha256Hex } from '@gallery/core';

/** 单次请求的时限：CDN 卡住不该让整个搜索页永远停在「加载中」。 */
export const FETCH_TIMEOUT_MS = 20_000;

const showHost = (host) => (host.includes('://') ? host : `https://${host}`);

function describeError(e) {
  const code = e?.cause?.code || e?.code;
  if (e?.name === 'TimeoutError') return `超过 ${FETCH_TIMEOUT_MS / 1000} 秒无回应`;
  return code ? `${e.message}（${code}）` : e.message;
}

async function get(fetchImpl, url, { timeoutMs = FETCH_TIMEOUT_MS, json = false } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
  return json ? res.json() : new Uint8Array(await res.arrayBuffer());
}

/**
 * 依次尝试每个主机；第一个成功的返回，全失败时把所有失败原因拼起来。
 * @template T
 * @param {string[]} hosts
 * @param {(host: string) => Promise<T>} attempt
 * @returns {Promise<{ host: string, value: T }>}
 */
async function firstHost(hosts, attempt) {
  const problems = [];
  for (const host of hosts) {
    try {
      return { host, value: await attempt(host) };
    } catch (e) {
      problems.push(`${host}：${describeError(e)}`);
    }
  }
  throw new Error(`所有图片域名都取不到（${problems.join('；')}）`);
}

/**
 * 读取当前检索库并打开。返回的 db 由调用方负责 close()。
 * @param {{
 *   config: { images: { hosts: string[] }, db: { prefix: string } },
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ db: import('@sqlite.org/sqlite-wasm').Database, meta: object, host: string }>}
 */
export async function loadGalleryDb({ config, fetchImpl = fetch }) {
  const hosts = (config.images?.hosts ?? []).map(showHost);
  if (hosts.length === 0) throw new Error('site.config.yaml 没有配 images.hosts');
  const prefix = config.db?.prefix ?? '';
  if (!prefix) throw new Error('site.config.yaml 没有配 db.prefix');

  // 1. 当前版本指针：db/manifest.json（publish:r2 在全部核对通过后才更新它）
  const manifest = await firstHost(hosts, (host) => get(fetchImpl, `${host}/${prefix}manifest.json`, { json: true }));
  const meta = manifest.value?.db;
  if (!meta || typeof meta !== 'object' || !meta.key) {
    throw new Error(`${showHost(manifest.host)}/${prefix}manifest.json 没有 db 字段：检索库还没发布过？`);
  }

  // 2. 整份下载并校验。size 与 sha256 都来自 manifest，是构建期对导出字节算的
  const fetched = await firstHost(hosts, async (host) => {
    const bytes = await get(fetchImpl, `${host}/${prefix}${meta.key}`);
    if (typeof meta.size === 'number' && bytes.byteLength !== meta.size) {
      throw new Error(`长度 ${bytes.byteLength} 与 manifest 的 ${meta.size} 不符（截断或 CDN 回错对象）`);
    }
    if (meta.sha256) {
      const actual = await sha256Hex(bytes);
      if (actual !== meta.sha256) {
        throw new Error(`sha256 ${actual.slice(0, 12)}… 与 manifest 的 ${String(meta.sha256).slice(0, 12)}… 不符（字节损坏）`);
      }
    }
    return bytes;
  });

  // 3. 打开。整份 sha256 已经证明字节完整，不再跑 quick_check（全库扫描，库大时很慢）
  const db = await openGalleryDb(fetched.value);
  return { db, meta, host: fetched.host };
}
