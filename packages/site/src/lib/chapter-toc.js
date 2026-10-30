// 完整目录只在打开时读取作品索引；HTML 保留静态目录链接，失败不妨碍继续阅读。
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const isId = (value) => typeof value === 'string' && ID.test(value);
const PROGRESS_PREFIX = 'gallery:progress:';
const PAGE_SIZE = 100;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

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
        || typeof chapter.title !== 'string' || !Number.isFinite(chapter.number) || !positiveInteger(chapter.pages)
        || seen.has(key) || rows.length >= 20000) {
        throw new Error('章节目录格式错误');
      }
      seen.add(key);
      rows.push({ key, url: chapter.url, title: `${chapter.number}. ${chapter.title}`, issue: `${issue.number}. ${issue.title}`, pages: chapter.pages });
    }
  }
  return rows;
}

/**
 * #toc 的 hidden 属性是唯一的打开状态，兼容现有按钮、快捷键与面板互斥逻辑。
 * @param {HTMLElement} toc
 * @param {{fetcher?: typeof fetch, timeoutMs?: number, getStorage?: () => Storage}} options
 */
export function mountChapterToc(toc, { fetcher, timeoutMs = 15000, getStorage } = {}) {
  const doc = toc.ownerDocument;
  const win = doc.defaultView;
  const request = fetcher ?? win.fetch.bind(win);
  const filter = toc.querySelector('[data-toc-filter]');
  const controls = toc.querySelector('[data-toc-controls]');
  const status = toc.querySelector('[data-toc-status]');
  const retry = toc.querySelector('[data-toc-retry]');
  const locate = toc.querySelector('[data-toc-locate]');
  const list = toc.querySelector('[data-toc-list]');
  const progressFilter = toc.querySelector('[data-toc-progress-filter]');
  const order = toc.querySelector('[data-toc-order]');
  const progressSummary = toc.querySelector('[data-toc-progress-summary]');
  const progressNote = toc.querySelector('[data-toc-progress-note]');
  const pagination = toc.querySelector('[data-toc-pagination]');
  const previousPage = toc.querySelector('[data-toc-page-prev]');
  const nextPage = toc.querySelector('[data-toc-page-next]');
  const pageStatus = toc.querySelector('[data-toc-page-status]');
  const pageForm = toc.querySelector('[data-toc-page-form]');
  const pageInput = toc.querySelector('[data-toc-page-input]');
  const pageGo = toc.querySelector('[data-toc-page-go]');
  const pageError = toc.querySelector('[data-toc-page-error]');
  const toggle = doc.getElementById('toc-btn');
  const core = doc.getElementById('reader')?.galleryReader;
  const readStorage = getStorage ?? (() => win.localStorage);
  const { seriesId, chapterKey } = toc.dataset;
  let phase = 'idle';
  let rows = [];
  let pageIndex = 0;
  let matchedCount = 0;
  let jumpDraft = false;
  let jumpInvalid = false;
  let currentRow = null;
  let currentLink = null;
  let currentIndicator = null;
  let controller = null;
  let timer = null;
  let destroyed = false;
  const progress = new Map();

  function clearJumpError() {
    jumpInvalid = false;
    pageInput?.removeAttribute('aria-invalid');
    if (pageError) { pageError.hidden = true; pageError.textContent = ''; }
  }
  function resetJump() {
    jumpDraft = false;
    clearJumpError();
  }
  function requestedGroup(totalPages) {
    const value = pageInput?.value.trim() ?? '';
    const number = /^[0-9]+$/.test(value) ? Number(value) : 0;
    return positiveInteger(number) && number <= totalPages ? number : null;
  }
  function showJumpError(totalPages) {
    jumpInvalid = true;
    pageInput?.setAttribute('aria-invalid', 'true');
    if (pageError) {
      pageError.hidden = false;
      pageError.textContent = `请输入 1 到 ${totalPages} 之间的整数。`;
    }
  }

  function currentProgress() {
    const row = currentRow;
    if (!row || !core) return null;
    try {
      const page = core.getState().page;
      return positiveInteger(page) ? { state: 'started', page: Math.min(row.pages, page), live: true } : null;
    } catch { return null; }
  }
  function readProgress(row, storage) {
    try {
      const raw = storage.getItem(PROGRESS_PREFIX + row.key);
      if (raw === null) return { state: 'new' };
      let value;
      try { value = JSON.parse(raw); } catch { return { state: 'new' }; }
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.url !== row.url || !positiveInteger(value.n)) return { state: 'new' };
      return { state: 'started', page: Math.min(row.pages, value.n) };
    } catch { return { state: 'unavailable' }; }
  }
  function refreshProgress(selectCurrent = false) {
    if (destroyed || toc.hidden || phase !== 'ready') return;
    let storage;
    try { storage = readStorage(); } catch { /* 各行显示无法读取，当前页仍可使用本页核心进度。 */ }
    for (const row of rows) progress.set(row.key, readProgress(row, storage));
    const current = currentProgress();
    if (current) progress.set(chapterKey, current);
    render({ selectCurrent });
  }
  function progressLabel(row, record) {
    if (record.state === 'unavailable') return '记录不可用';
    if (record.state !== 'started') return '暂无进度';
    const prefix = record.live ? '本页进度 · ' : '';
    return prefix + (record.page === row.pages ? `已到末页 · ${row.pages} 页` : `读至第 ${record.page} / ${row.pages} 页`);
  }

  function render({ selectCurrent = false, resetScroll = false, preserveFocus = true } = {}) {
    const active = doc.activeElement;
    const focusedKey = list.contains?.(active) ? active?.dataset.tocChapterKey : null;
    const previousScroll = list.scrollTop;
    const query = filter.value.trim().normalize('NFKC').toLowerCase();
    const progressMode = progressFilter?.value ?? 'all';
    const matches = rows.filter((row) => `${row.title} ${row.issue}`.normalize('NFKC').toLowerCase().includes(query)
      && (progressMode === 'all' || progress.get(row.key)?.state === progressMode));
    // 筛选创建独立数组；倒序作用于整个结果，再分组，不修改原索引。
    if (order?.value === 'desc') matches.reverse();
    matchedCount = matches.length;
    const previousIndex = pageIndex;
    const totalPages = Math.max(1, Math.ceil(matchedCount / PAGE_SIZE));
    // 主动定位优先；外部进度变化时跟随仍存在的焦点章节，避免键盘焦点丢失。
    const targetKey = selectCurrent ? chapterKey : preserveFocus ? focusedKey : null;
    const targetIndex = targetKey ? matches.findIndex((row) => row.key === targetKey) : -1;
    pageIndex = targetIndex >= 0 ? Math.floor(targetIndex / PAGE_SIZE) : Math.min(pageIndex, totalPages - 1);
    const start = pageIndex * PAGE_SIZE;
    const pageRows = matches.slice(start, start + PAGE_SIZE);
    const fragment = doc.createDocumentFragment();
    const links = new Map();
    currentLink = null;
    currentIndicator = null;
    for (const row of pageRows) {
      const item = doc.createElement('li');
      const link = doc.createElement('a');
      const issue = doc.createElement('small');
      const indicator = doc.createElement('span');
      const record = progress.get(row.key) ?? { state: 'unavailable' };
      link.href = record.state === 'started' ? `${row.url}#p${record.page}` : row.url;
      link.dataset.tocChapterKey = row.key;
      link.textContent = row.title;
      issue.textContent = row.issue;
      indicator.className = 'toc-progress';
      indicator.dataset.state = record.state;
      indicator.textContent = progressLabel(row, record);
      if (row.key === chapterKey) {
        link.setAttribute('aria-current', 'page');
        link.className = 'current';
        currentLink = link;
        currentIndicator = indicator;
      }
      links.set(row.key, link);
      item.append(link, issue, indicator);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
    list.scrollTop = resetScroll || previousIndex !== pageIndex ? 0 : previousScroll;
    status.textContent = !matchedCount ? '没有匹配的章节。可清空筛选或定位当前章。'
      : matchedCount > PAGE_SIZE ? `显示 ${start + 1}–${start + pageRows.length} / ${matchedCount} 话（共 ${rows.length} 话）`
      : `显示 ${matchedCount} / ${rows.length} 话`;
    if (pagination) pagination.hidden = matchedCount <= PAGE_SIZE;
    if (previousPage) previousPage.disabled = pageIndex === 0;
    if (nextPage) nextPage.disabled = pageIndex === totalPages - 1;
    if (pageStatus) pageStatus.textContent = matchedCount ? `第 ${pageIndex + 1} / ${totalPages} 组` : '';
    if (matchedCount <= PAGE_SIZE) resetJump();
    if (pageInput) {
      pageInput.max = String(totalPages);
      pageInput.disabled = matchedCount <= PAGE_SIZE;
      if (!jumpDraft) pageInput.value = String(pageIndex + 1);
    }
    if (pageGo) pageGo.disabled = matchedCount <= PAGE_SIZE;
    if (jumpInvalid) {
      if (requestedGroup(totalPages) !== null) clearJumpError();
      else showJumpError(totalPages);
    }
    const started = rows.filter((row) => progress.get(row.key)?.state === 'started').length;
    const fresh = rows.filter((row) => progress.get(row.key)?.state === 'new').length;
    const unavailable = rows.length - started - fresh;
    if (progressSummary) progressSummary.textContent = `${started} 话有进度 · ${fresh} 话暂无进度` + (unavailable ? ` · ${unavailable} 话记录不可用` : '');
    if (progressNote) {
      progressNote.hidden = !unavailable;
      progressNote.textContent = unavailable ? '部分阅读记录暂时无法读取，不会被视为暂无进度。仍可使用目录链接阅读。' : '';
    }
    if (focusedKey && preserveFocus) {
      const focusedLink = links.get(focusedKey);
      (focusedLink ?? progressFilter ?? filter).focus({ preventScroll: true });
      if (focusedLink && previousIndex !== pageIndex) revealLink(focusedLink);
    }
    else if (pagination && (active === previousPage || active === nextPage || active === pageStatus || active === pageInput || active === pageGo)) {
      // 当前按钮变成禁用或整个分页区消失时，焦点仍落在可操作、可见的控件上。
      const target = pagination.hidden ? filter
        : active.disabled ? (!previousPage.disabled ? previousPage : !nextPage.disabled ? nextPage : pageStatus)
        : active;
      target.focus({ preventScroll: true });
    }
    return links.values().next().value;
  }

  function revealLink(link, focus = false) {
    if (!link || toc.hidden) return;
    // 只移动目录自己的滚动条，不把读者正在看的漫画一起滚走。
    const target = link.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    const panel = toc.getBoundingClientRect();
    const visibleTop = Math.max(viewport.top, panel.top);
    const visibleBottom = Math.min(viewport.bottom, panel.bottom);
    const canFit = visibleBottom - visibleTop >= target.height;
    const top = canFit ? visibleTop : viewport.top;
    const bottom = canFit ? visibleBottom : viewport.bottom;
    const previousListScroll = list.scrollTop;
    const previousPanelScroll = toc.scrollTop;
    // 可见交集不足一行时，先保证链接在列表内部完整可见，再露出目录外框中的这一行。
    if (bottom > top && (target.top < top || target.bottom > bottom)) {
      const desired = list.scrollTop + target.top - top - (bottom - top) / 2 + target.height / 2;
      list.scrollTop = desired;
      // 列表首尾可能无法继续滚动，剩余距离由目录外框承担，仍不移动漫画。
      const remaining = desired - list.scrollTop;
      if (Math.abs(remaining) > 1) toc.scrollTop += remaining;
    }
    const moved = list.scrollTop - previousListScroll + toc.scrollTop - previousPanelScroll;
    if (target.top - moved < panel.top) toc.scrollTop += target.top - moved - panel.top;
    else if (target.bottom - moved > panel.bottom) toc.scrollTop += target.bottom - moved - panel.bottom;
    if (focus) link.focus({ preventScroll: true });
  }
  function locateCurrent(focus = false) {
    revealLink(currentLink, focus);
  }

  async function load() {
    if (destroyed || phase === 'loading' || phase === 'ready') return;
    phase = 'loading';
    retry.hidden = true;
    controls.hidden = true;
    if (pagination) pagination.hidden = true;
    if (order) order.disabled = true;
    resetJump();
    if (pageInput) pageInput.disabled = true;
    if (pageGo) pageGo.disabled = true;
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
      const loadedCurrent = loaded.find((row) => row.key === chapterKey);
      if (!loadedCurrent) throw new Error('目录缺少当前章');
      rows = loaded;
      currentRow = loadedCurrent;
      phase = 'ready';
      controls.hidden = false;
      if (order) order.disabled = false;
      if (toc.hidden) render({ selectCurrent: true });
      else refreshProgress(true);
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
    else if (phase === 'ready') { refreshProgress(true); locateCurrent(); }
  }
  const onFilter = () => {
    if (destroyed || toc.hidden || phase !== 'ready') return;
    resetJump();
    pageIndex = 0;
    render({ resetScroll: true, preserveFocus: false });
  };
  const onLocate = () => {
    if (destroyed || toc.hidden || phase !== 'ready') return;
    resetJump();
    filter.value = '';
    if (progressFilter) progressFilter.value = 'all';
    render({ selectCurrent: true, resetScroll: true, preserveFocus: false });
    locateCurrent(true);
  };
  function changePage(delta) {
    if (destroyed || toc.hidden || phase !== 'ready') return;
    const target = Math.max(0, Math.min(pageIndex + delta, Math.ceil(matchedCount / PAGE_SIZE) - 1));
    if (pageIndex === target) return;
    resetJump();
    pageIndex = target;
    render({ resetScroll: true, preserveFocus: false });
  }
  const onPreviousPage = () => changePage(-1);
  const onNextPage = () => changePage(1);
  const onJumpInput = () => {
    if (destroyed || toc.hidden || phase !== 'ready' || matchedCount <= PAGE_SIZE) return;
    jumpDraft = true;
    clearJumpError();
  };
  const onJump = (event) => {
    event.preventDefault();
    if (destroyed || toc.hidden || phase !== 'ready' || matchedCount <= PAGE_SIZE || !pageInput) return;
    const totalPages = Math.ceil(matchedCount / PAGE_SIZE);
    const group = requestedGroup(totalPages);
    if (group === null) {
      showJumpError(totalPages);
      pageInput.focus({ preventScroll: true });
      return;
    }
    resetJump();
    pageIndex = group - 1;
    const firstLink = render({ resetScroll: true, preserveFocus: false });
    revealLink(firstLink, true);
  };
  const onRetry = () => { if (!toc.hidden) void load(); };
  const onStorage = (event) => {
    if (phase !== 'ready' || toc.hidden) return;
    if (event.key === null || rows.some((row) => event.key === PROGRESS_PREFIX + row.key)) refreshProgress();
  };
  const onShow = () => refreshProgress();
  const unsubscribe = core?.subscribe?.(() => {
    if (destroyed || toc.hidden || phase !== 'ready') return;
    const current = currentProgress();
    if (!current) return;
    const previous = progress.get(chapterKey);
    if (previous?.state === current.state && previous.page === current.page && previous.live === current.live) return;
    progress.set(chapterKey, current);
    if (previous?.state === 'started') {
      // 页码变化不会改变筛选归属；仅更新当前行，避免长目录翻页时重建全部节点。
      if (currentLink && currentIndicator) {
        currentLink.href = `${currentRow.url}#p${current.page}`;
        currentIndicator.textContent = progressLabel(currentRow, current);
      }
    } else render();
  });
  filter.addEventListener('input', onFilter);
  progressFilter?.addEventListener('change', onFilter);
  order?.addEventListener('change', onFilter);
  locate.addEventListener('click', onLocate);
  retry.addEventListener('click', onRetry);
  previousPage?.addEventListener('click', onPreviousPage);
  nextPage?.addEventListener('click', onNextPage);
  pageForm?.addEventListener('submit', onJump);
  pageInput?.addEventListener('input', onJumpInput);
  win.addEventListener('storage', onStorage);
  win.addEventListener('pageshow', onShow);
  win.addEventListener('focus', onShow);
  const observer = new win.MutationObserver(visibilityChanged);
  observer.observe(toc, { attributes: true, attributeFilter: ['hidden'] });
  toggle?.setAttribute('aria-controls', toc.id);
  visibilityChanged();

  return {
    destroy() {
      destroyed = true;
      if (order) order.disabled = true;
      if (pageInput) pageInput.disabled = true;
      if (pageGo) pageGo.disabled = true;
      controller?.abort();
      win.clearTimeout(timer);
      observer.disconnect();
      unsubscribe?.();
      filter.removeEventListener('input', onFilter);
      progressFilter?.removeEventListener('change', onFilter);
      order?.removeEventListener('change', onFilter);
      locate.removeEventListener('click', onLocate);
      retry.removeEventListener('click', onRetry);
      previousPage?.removeEventListener('click', onPreviousPage);
      nextPage?.removeEventListener('click', onNextPage);
      pageForm?.removeEventListener('submit', onJump);
      pageInput?.removeEventListener('input', onJumpInput);
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('pageshow', onShow);
      win.removeEventListener('focus', onShow);
    },
  };
}
