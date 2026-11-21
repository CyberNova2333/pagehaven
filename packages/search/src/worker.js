// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 浏览器检索 Web Worker：运行在独立线程，通过同步 XHR + sqlite3_vfs 按需拉取已验证的 64 KiB 块；
// 当所有源都不支持 Range 时，若在 whole_download_max_bytes 预算内，透明降级回整份下载并重跑当前查询。
import { consumeChunkedDbError, fetchRangeSync } from '@gallery/core';
import { loadGalleryDb } from './load.js';
import { queryLines } from './query.js';

/**
 * @param {{ fetchImpl?: typeof fetch, readRangeSync?: Function, sleepSync?: Function }} [deps]
 */
export function createSearchWorkerSession({
  fetchImpl = (...args) => globalThis.fetch(...args),
  readRangeSync = typeof XMLHttpRequest === 'function' ? fetchRangeSync : undefined,
  sleepSync,
} = {}) {
  let activeConfigKey;
  let loaded;
  let queue = Promise.resolve();
  const controller = new AbortController();

  function releaseDb() {
    loaded?.db.close();
    loaded = null;
  }

  function close() {
    controller.abort();
    releaseDb();
  }

  async function query({ config, query, seriesId = '', limit, offset = 0 }) {
    controller.signal.throwIfAborted();
    const key = JSON.stringify(config);
    if (!loaded || activeConfigKey !== key) {
      releaseDb();
      loaded = await loadGalleryDb({ config, fetchImpl, readRangeSync, sleepSync, signal: controller.signal });
      activeConfigKey = key;
    }
    const options = { seriesId, limit, offset };
    try {
      return { ...queryLines(loaded.db, query, options), modeUsed: loaded.mode };
    } catch (error) {
      const cause = consumeChunkedDbError(loaded.db) ?? error;
      const fallback = loaded.fallbackWhole;
      releaseDb();
      if (cause.code !== 'needs-whole' || !fallback) throw cause;
      loaded = await fallback();
      return { ...queryLines(loaded.db, query, options), modeUsed: loaded.mode };
    }
  }

  return {
    async handleMessage(msg) {
      const id = msg?.id ?? null;
      try {
        if (msg?.type === 'close') {
          close();
          return { id, ok: true, result: null };
        }
        if (msg?.type !== 'query') throw new Error(`未知 Worker 指令：${msg?.type}`);
        // 一次查询独占连接，切库、失败重试与 Range 退化都在下一条查询前结束。
        const result = queue.then(() => query(msg));
        queue = result.catch(() => {});
        return { id, ok: true, result: await result };
      } catch (error) {
        return { id, ok: false, error: error?.message ?? String(error), code: error?.code ?? null };
      }
    },
    close,
  };
}

const inDedicatedWorker =
  typeof WorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' &&
  self instanceof WorkerGlobalScope;

if (inDedicatedWorker) {
  const session = createSearchWorkerSession();
  self.addEventListener('message', async (event) => {
    const reply = await session.handleMessage(event.data);
    self.postMessage(reply);
  });
}
