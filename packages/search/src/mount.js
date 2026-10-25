// 搜索页接线：输入与文本覆盖率先校验，再按需加载构建时固定的检索库。
// 每批结果最多 50 条，用 hasMore 显示后续入口；失败不影响漫画浏览。
import { loadGalleryDb } from './load.js';
import { prepareQuery, queryLines } from './query.js';

/**
 * @param {{document?: Document, location?: Location, history?: History, fetchImpl?: typeof fetch}} [deps]
 */
export function mountSearch({ document: doc = globalThis.document, location = globalThis.location, history = globalThis.history, fetchImpl = fetch } = {}) {
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
  let db = null;
  let sequence = 0;
  let destroyed = false;
  let activeQuery = '';
  let activeSeries = '';
  let shown = 0;
  const controller = new AbortController();

  function getDb() {
    if (!dbPromise) {
      dbPromise = loadGalleryDb({ config, fetchImpl, signal: controller.signal })
        .then(({ db: opened }) => {
          db = opened;
          return opened;
        })
        .catch((e) => {
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
    if (prepareQuery(query).mode === 'too-short') {
      setStatus('请至少输入 2 个字（空格和标点不计入）。');
      return [];
    }
    if (more) more.disabled = true;
    setStatus(db ? '正在检索……' : '正在加载台词检索……');
    try {
      const conn = await getDb();
      if (seq !== sequence || destroyed) return [];
      const { rows, hasMore } = queryLines(conn, query, { seriesId, offset });
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
  const params = new URLSearchParams(location?.search ?? '');
  const initial = params.get('q') ?? '';
  input.value = initial;
  if (series) series.value = params.get('series') ?? '';
  if (more) more.hidden = true;
  if (initial.trim()) run(initial);
  else setStatus(noText ? emptyMessage : prompt);

  return {
    run,
    destroy() {
      destroyed = true;
      sequence += 1;
      controller.abort();
      form.removeEventListener('submit', submit);
      more?.removeEventListener('click', loadMore);
      series?.removeEventListener('change', submit);
      if (db) db.close();
      db = null;
      dbPromise = null;
    },
  };
}
