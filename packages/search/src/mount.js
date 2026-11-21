// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 两种构建共用查询、分页与展示，只有启用分块的页面入口提供 Worker 工厂。
import { foldText } from '@gallery/core/fold-text';

function createWorkerClient({ config, workerFactory }) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();
  let everResponded = false;

  function failAll(err) {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  }

  function ensureWorker() {
    if (worker) return worker;
    let w;
    try {
      w = workerFactory();
    } catch (cause) {
      throw Object.assign(new Error('检索 Worker 启动失败', { cause }), { workerStartupFailure: true });
    }
    everResponded = false;
    const onMessage = (event) => {
      if (w !== worker) return;
      const msg = event?.data;
      const job = pending.get(msg?.id);
      if (!job) return;
      everResponded = true;
      pending.delete(msg.id);
      if (msg.ok) job.resolve(msg.result);
      else {
        const err = new Error(msg.error || 'Worker 查询失败');
        if (msg.code) err.code = msg.code;
        job.reject(err);
      }
    };
    const onError = (event) => {
      if (w !== worker) return;
      const err = new Error(event?.message || '检索 Worker 启动或运行失败');
      if (!everResponded) err.workerStartupFailure = true;
      failAll(err);
      terminate();
    };
    if (typeof w.addEventListener === 'function') {
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      w.addEventListener('messageerror', onError);
    } else {
      w.onmessage = onMessage;
      w.onerror = onError;
    }
    worker = w;
    return worker;
  }

  function terminate() {
    const w = worker;
    worker = null;
    if (!w) return;
    w.terminate?.();
  }

  return {
    async query({ query, seriesId, offset }) {
      const w = ensureWorker();
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          w.postMessage({ id, type: 'query', config, query, seriesId, offset });
        } catch (e) {
          pending.delete(id);
          reject(e);
        }
      });
    },
    destroy() {
      failAll(new DOMException('检索已关闭', 'AbortError'));
      terminate();
    },
  };
}

/**
 * @param {{document?: Document, location?: Location, history?: History, fetchImpl?: typeof fetch,
 *   workerFactory?: () => Worker}} [deps]
 */
export function mountSearch({
  document: doc = globalThis.document,
  location = globalThis.location,
  history = globalThis.history,
  fetchImpl,
  workerFactory,
} = {}) {
  const configEl = doc?.getElementById?.('search-config');
  const form = doc?.getElementById?.('search-form');
  const input = doc?.getElementById?.('search-input');
  const status = doc?.getElementById?.('search-status');
  const list = doc?.getElementById?.('search-results');
  if (!configEl || !form || !input || !status || !list) return null;

  const more = doc.getElementById('search-more');
  const series = doc.getElementById('search-series');
  const coverageEl = doc.getElementById('search-coverage');
  const config = JSON.parse(configEl.textContent);
  const coverage = config.coverage;
  const noText = coverage && (coverage.withText === 0 || coverage.boxes === 0);
  const emptyMessage = coverage?.chapters === 0
    ? '当前还没有作品，内容发布后即可检索。'
    : '当前尚未收录可检索的台词，作品和漫画仍可正常浏览。';
  const prompt = '输入至少 2 个字开始检索；可先选择作品缩小范围。';
  if (coverageEl && coverage) coverageEl.textContent = `台词稿覆盖 ${coverage.withText} / ${coverage.chapters} 话，共 ${coverage.boxes} 个文本框。`;
  const setStatus = (text) => { status.textContent = text; };
  const clear = () => {
    while (list.firstChild) list.removeChild(list.firstChild);
  };

  let dbPromise = null;
  let loadedDb = null;
  let workerClient = null;
  let workerDisabled = false;
  let hasReadyDb = false;
  let sequence = 0;
  let destroyed = false;
  let activeQuery = '';
  let activeSeries = '';
  let shown = 0;
  const controller = new AbortController();

  function getInThreadDb() {
    if (!dbPromise) {
      dbPromise = Promise.all([import('./whole.js'), import('./query.js')])
        .then(async ([{ loadWholeDb }, { queryLines }]) => {
          const { db } = await loadWholeDb({ config, fetchImpl: fetchImpl ?? fetch, signal: controller.signal });
          if (controller.signal.aborted) {
            db.close();
            controller.signal.throwIfAborted();
          }
          loadedDb = db;
          return { db, queryLines };
        })
        .catch((e) => {
          dbPromise = null;
          throw e;
        });
    }
    return dbPromise;
  }

  async function executeInThread({ query, seriesId, offset }) {
    const { db, queryLines } = await getInThreadDb();
    controller.signal.throwIfAborted();
    return queryLines(db, query, { seriesId, offset });
  }

  function runQuery({ query, seriesId, offset }) {
    if (workerFactory && !workerDisabled) {
      if (!workerClient) workerClient = createWorkerClient({ config, workerFactory });
      return workerClient.query({ query, seriesId, offset }).catch((e) => {
        if (!e?.workerStartupFailure || destroyed) throw e;
        // Worker 脚本无法创建/初始化时仅回退一次到同线程路径
        workerDisabled = true;
        workerClient?.destroy();
        workerClient = null;
        return executeInThread({ query, seriesId, offset });
      });
    }
    return executeInThread({ query, seriesId, offset });
  }

  function render(rows) {
    for (const r of rows) {
      const li = doc.createElement('li');
      const a = doc.createElement('a');
      a.href = r.url;
      a.textContent = r.text;
      const meta = doc.createElement('small');
      meta.textContent = ` ${r.seriesTitle ?? r.seriesId} · ${r.chapterTitle ?? r.chapterId} · 第 ${r.pageN} 页`;
      li.append(a, meta);
      list.append(li);
    }
  }

  async function searchPage(append) {
    if (destroyed) return [];
    const seq = ++sequence;
    const query = activeQuery;
    const seriesId = activeSeries;
    const offset = append ? shown : 0;
    if (!append) {
      clear();
      shown = 0;
      if (more) more.hidden = true;
    }
    if (noText) {
      setStatus(emptyMessage);
      return [];
    }
    if (!query.trim()) {
      setStatus(prompt);
      return [];
    }
    // 当前 t → cn 词典逐条保持码位数，normalize.test.js 用实际词典验证这个前提。
    if ([...foldText(query).toLowerCase()].length < 2) {
      setStatus('请至少输入 2 个字（空格和标点不计入）。');
      return [];
    }
    if (more) more.disabled = true;
    setStatus(hasReadyDb ? '正在检索……' : '正在加载台词检索……');
    try {
      const result = await runQuery({ query, seriesId, offset });
      if (seq !== sequence || destroyed) return [];
      hasReadyDb = true;
      const { rows, hasMore } = result;
      render(rows);
      shown += rows.length;
      if (more) more.hidden = !hasMore;
      setStatus(hasMore ? `已显示 ${shown} 条台词，还有更多结果。` : shown ? `找到 ${shown} 条台词` : '已收录的台词中没有匹配结果。');
      return rows;
    } catch (e) {
      if (seq !== sequence || destroyed) return [];
      setStatus(`检索暂不可用：${e.message}。`);
      return [];
    } finally {
      if (seq === sequence && more) more.disabled = false;
    }
  }

  function run(rawQuery) {
    activeQuery = String(rawQuery ?? '');
    activeSeries = series?.value ?? '';
    return searchPage(false);
  }

  let lastSearch;
  function submit(event) {
    event?.preventDefault?.();
    const q = input.value;
    try {
      const url = new URL(location.href);
      if (q) url.searchParams.set('q', q);
      else url.searchParams.delete('q');
      if (series?.value) url.searchParams.set('series', series.value);
      else url.searchParams.delete('series');
      history.replaceState(null, '', url);
      lastSearch = url.search;
    } catch {
      // 没有 history / location 的环境忽略。
    }
    return run(q);
  }

  function loadMore() {
    if (more?.disabled || more?.hidden) return Promise.resolve([]);
    return searchPage(true);
  }

  form.addEventListener('submit', submit);
  more?.addEventListener('click', loadMore);
  series?.addEventListener('change', submit);
  function restoreFromUrl() {
    const search = location?.search ?? '';
    if (search === lastSearch) return;
    lastSearch = search;
    const params = new URLSearchParams(search);
    input.value = params.get('q') ?? '';
    if (series) series.value = params.get('series') ?? '';
    return run(input.value);
  }
  restoreFromUrl();

  return {
    run,
    restoreFromUrl,
    destroy() {
      destroyed = true;
      sequence += 1;
      controller.abort();
      form.removeEventListener('submit', submit);
      more?.removeEventListener('click', loadMore);
      series?.removeEventListener('change', submit);
      workerClient?.destroy();
      workerClient = null;
      loadedDb?.close();
      loadedDb = null;
      dbPromise = null;
    },
  };
}
