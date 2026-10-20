// 搜索页接线：读 #search-config、按需加载检索库、把结果渲染进约定的 #search-results。
//
// 页面结构是约定（packages/site/README「搜索页的约定 id」），这里只认 id，不重建 DOM：
//   #search-form / #search-input / #search-status / #search-results / #search-config
// 首次搜索才加载库（30 MB 以内整份下载）；加载失败只影响检索，作品与话页面照常。
// 函数版检索（features.search_function、/api/search）尚未实现：探测不到就走浏览器端这条，
// 等函数真的有了再在这里加「先探函数、失败回退」的分支。

import { loadGalleryDb } from './load.js';
import { queryLines } from './query.js';

const DEFAULT_MIN = 3;

/**
 * @param {{
 *   document?: Document, location?: Location, history?: History, fetchImpl?: typeof fetch,
 * }} [deps]  全部可注入，方便在没有 DOM 的环境里验纯逻辑之外的接线
 * @returns {{ run: (q: string) => Promise<object[]>, destroy: () => void } | null}
 */
export function mountSearch({ document: doc = globalThis.document, location = globalThis.location, history = globalThis.history, fetchImpl = fetch } = {}) {
  const configEl = doc?.getElementById?.('search-config');
  const form = doc?.getElementById?.('search-form');
  const input = doc?.getElementById?.('search-input');
  const status = doc?.getElementById?.('search-status');
  const list = doc?.getElementById?.('search-results');
  if (!configEl || !form || !input || !status || !list) return null;

  const config = JSON.parse(configEl.textContent);
  const minMatchLength = Number(config.search?.min_match_length) || DEFAULT_MIN;
  const setStatus = (text) => {
    status.textContent = text;
  };
  const clear = () => {
    while (list.firstChild) list.removeChild(list.firstChild);
  };

  /** @type {Promise<import('@sqlite.org/sqlite-wasm').Database> | null} */
  let dbPromise = null;
  let db = null;
  // 每次搜索递增：库加载慢、用户又改了词时，旧请求的结果不许盖掉新的
  let sequence = 0;

  function getDb() {
    if (!dbPromise) {
      dbPromise = loadGalleryDb({ config, fetchImpl })
        .then(({ db: opened }) => {
          db = opened;
          return opened;
        })
        .catch((e) => {
          // 加载失败允许下次重试（CDN 抖一下不该让整页永远不可用）
          dbPromise = null;
          throw e;
        });
    }
    return dbPromise;
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

  async function run(rawQuery) {
    const query = String(rawQuery ?? '');
    const seq = ++sequence;
    clear();
    if (!query.trim()) {
      setStatus(minMatchLength >= 3 ? `输入台词片段开始检索（至少 ${minMatchLength} 个字）` : '输入台词片段开始检索');
      return [];
    }
    setStatus('检索库加载中……（首次需要几秒）');
    try {
      const conn = await getDb();
      if (seq !== sequence) return [];
      const { mode, rows } = queryLines(conn, query, { minMatchLength });
      if (seq !== sequence) return [];
      if (mode === 'too-short') {
        setStatus('至少输入 3 个字：1 个字不检索，2 个字按 LIKE 全表扫');
        return [];
      }
      render(rows);
      setStatus(rows.length ? `找到 ${rows.length} 条台词` : '没有找到台词');
      return rows;
    } catch (e) {
      if (seq !== sequence) return [];
      setStatus(`检索暂不可用：${e.message}。作品与话页面不受影响。`);
      return [];
    }
  }

  function submit(event) {
    event?.preventDefault?.();
    const q = input.value;
    // q 留在 URL 里：刷新、分享、从结果页返回都能复现这次搜索
    try {
      const url = new URL(location.href);
      if (q) url.searchParams.set('q', q);
      else url.searchParams.delete('q');
      history.replaceState(null, '', url);
    } catch {
      /* 没有 history / location 的环境（测试）忽略 */
    }
    run(q);
  }

  form.addEventListener('submit', submit);
  const initial = new URLSearchParams(location?.search ?? '').get('q') ?? '';
  input.value = initial;
  if (initial.trim()) run(initial);
  else setStatus(minMatchLength >= 3 ? `输入台词片段开始检索（至少 ${minMatchLength} 个字）` : '输入台词片段开始检索');

  return {
    run,
    destroy() {
      if (db) db.close();
      db = null;
      dbPromise = null;
    },
  };
}
