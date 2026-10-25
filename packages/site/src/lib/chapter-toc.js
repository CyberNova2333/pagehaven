// 完整目录只在打开时读取作品索引；HTML 保留静态目录链接，失败不妨碍继续阅读。
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const isId = (value) => typeof value === 'string' && ID.test(value);

/** 校验索引中的路由与章节身份，不接受跨作品、外部或带查询串的链接。 */
export function parseChapterIndex(data, seriesId) {
  if (!isId(seriesId) || data?.id !== seriesId || !Array.isArray(data.issues)) throw new Error('作品目录不匹配');
  const rows = [];
  const seen = new Set();
  for (const issue of data.issues) {
    if (!isId(issue?.id) || typeof issue.title !== 'string' || !Number.isFinite(issue.number) || !Array.isArray(issue.chapters)) {
      throw new Error('期目录格式错误');
    }
    for (const chapter of issue.chapters) {
      const key = `${seriesId}/${issue.id}/${chapter?.id}`;
      if (!isId(chapter?.id) || chapter.key !== key || chapter.url !== `/${key}/`
        || typeof chapter.title !== 'string' || !Number.isFinite(chapter.number) || seen.has(key)) {
        throw new Error('章节目录格式错误');
      }
      seen.add(key);
      rows.push({ key, url: chapter.url, title: `${chapter.number}. ${chapter.title}`, issue: `${issue.number}. ${issue.title}` });
    }
  }
  return rows;
}

/**
 * #toc 的 hidden 属性是唯一的打开状态，兼容现有按钮、快捷键与面板互斥逻辑。
 * @param {HTMLElement} toc
 * @param {{fetcher?: typeof fetch, timeoutMs?: number}} options
 */
export function mountChapterToc(toc, { fetcher, timeoutMs = 15000 } = {}) {
  const doc = toc.ownerDocument;
  const win = doc.defaultView;
  const request = fetcher ?? win.fetch.bind(win);
  const filter = toc.querySelector('[data-toc-filter]');
  const controls = toc.querySelector('[data-toc-controls]');
  const status = toc.querySelector('[data-toc-status]');
  const retry = toc.querySelector('[data-toc-retry]');
  const locate = toc.querySelector('[data-toc-locate]');
  const list = toc.querySelector('[data-toc-list]');
  const toggle = doc.getElementById('toc-btn');
  const { seriesId, chapterKey } = toc.dataset;
  let phase = 'idle';
  let rows = [];
  let currentLink = null;
  let controller = null;
  let timer = null;
  let destroyed = false;

  function render() {
    const query = filter.value.trim().normalize('NFKC').toLowerCase();
    const matches = rows.filter((row) => `${row.title} ${row.issue}`.normalize('NFKC').toLowerCase().includes(query));
    const fragment = doc.createDocumentFragment();
    currentLink = null;
    for (const row of matches) {
      const item = doc.createElement('li');
      const link = doc.createElement('a');
      const issue = doc.createElement('small');
      link.href = row.url;
      link.textContent = row.title;
      issue.textContent = row.issue;
      if (row.key === chapterKey) {
        link.setAttribute('aria-current', 'page');
        link.className = 'current';
        currentLink = link;
      }
      item.append(link, issue);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
    status.textContent = matches.length ? `显示 ${matches.length} / ${rows.length} 话` : '没有匹配的章节。可清空筛选或定位当前章。';
  }

  function locateCurrent(focus = false) {
    if (!currentLink || toc.hidden) return;
    // 只移动目录自己的滚动条，不把读者正在看的漫画一起滚走。
    const target = currentLink.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (target.top < viewport.top || target.bottom > viewport.bottom) {
      list.scrollTop += target.top - viewport.top - list.clientHeight / 2 + target.height / 2;
    }
    if (focus) currentLink.focus({ preventScroll: true });
  }

  async function load() {
    if (destroyed || phase === 'loading' || phase === 'ready') return;
    phase = 'loading';
    retry.hidden = true;
    controls.hidden = true;
    toc.setAttribute('aria-busy', 'true');
    status.textContent = '目录加载中…';
    controller = new AbortController();
    const signal = controller.signal;
    try {
      if (!isId(seriesId)) throw new Error('作品标识无效');
      const timeout = new Promise((_, reject) => {
        timer = win.setTimeout(() => { controller.abort(); reject(new Error('目录加载超时')); }, timeoutMs);
      });
      const pending = Promise.resolve().then(async () => {
        const response = await request(`/index/${seriesId}.json`, { signal });
        if (!response.ok) throw new Error('目录请求失败');
        return parseChapterIndex(await response.json(), seriesId);
      });
      const loaded = await Promise.race([pending, timeout]);
      if (destroyed) return;
      if (!loaded.some((row) => row.key === chapterKey)) throw new Error('目录缺少当前章');
      rows = loaded;
      phase = 'ready';
      controls.hidden = false;
      render();
      locateCurrent();
    } catch {
      if (destroyed) return;
      phase = 'error';
      status.textContent = '目录加载失败。可以重试，或使用上方的作品 / 本期目录链接。';
      retry.hidden = false;
    } finally {
      win.clearTimeout(timer);
      timer = null;
      if (!destroyed) toc.setAttribute('aria-busy', 'false');
    }
  }

  function visibilityChanged() {
    if (destroyed) return;
    toggle?.setAttribute('aria-expanded', String(!toc.hidden));
    if (toc.hidden) return;
    if (phase === 'idle') void load();
    else if (phase === 'ready') locateCurrent();
  }
  const onFilter = () => { if (phase === 'ready') render(); };
  const onLocate = () => {
    if (phase !== 'ready') return;
    filter.value = '';
    render();
    locateCurrent(true);
  };
  const onRetry = () => { if (!toc.hidden) void load(); };
  filter.addEventListener('input', onFilter);
  locate.addEventListener('click', onLocate);
  retry.addEventListener('click', onRetry);
  const observer = new win.MutationObserver(visibilityChanged);
  observer.observe(toc, { attributes: true, attributeFilter: ['hidden'] });
  toggle?.setAttribute('aria-controls', toc.id);
  visibilityChanged();

  return {
    destroy() {
      destroyed = true;
      controller?.abort();
      win.clearTimeout(timer);
      observer.disconnect();
      filter.removeEventListener('input', onFilter);
      locate.removeEventListener('click', onLocate);
      retry.removeEventListener('click', onRetry);
    },
  };
}
