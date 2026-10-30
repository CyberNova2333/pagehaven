import { createLibraryStore, readReadingProgress, LIBRARY_PREFIX, READING_STATUSES } from './library.js';
import { createStorageRefresh } from './storage-refresh.js';

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TEMPORARY_NOTE = '浏览器未允许保存书架，本页操作仅临时保留；离开或刷新页面后可能丢失。';
const PROGRESS_NOTE = '部分阅读记录暂时无法读取，最近阅读与继续阅读可能不完整；原记录不会被改动。';
const statusLabel = (value) => READING_STATUSES.find((status) => status.value === value)?.label ?? '';

/** 作品页只在明确操作时收藏或修改状态，阅读进度由原阅读器维护。 */
export function mountSeriesLibrary(root, options = {}) {
  const win = root.ownerDocument.defaultView;
  const store = options.store ?? createLibraryStore({ getStorage: () => win.localStorage });
  const { seriesId } = root.dataset;
  if (!ID.test(seriesId ?? '')) return;
  const add = root.querySelector('[data-library-add]');
  const status = root.querySelector('[data-library-status]');
  const remove = root.querySelector('[data-library-remove]');
  const message = root.querySelector('[data-library-message]');
  const storageRefresh = createStorageRefresh(win, () => refresh());

  function refresh(feedback = '') {
    storageRefresh.cancel();
    const active = root.ownerDocument.activeElement;
    const entry = store.read(seriesId);
    add.hidden = Boolean(entry);
    status.parentElement.hidden = !entry;
    remove.hidden = !entry;
    if (entry) status.value = entry.status;
    message.textContent = store.limited ? TEMPORARY_NOTE : feedback;
    root.hidden = false;
    if (entry && active === add) status.focus({ preventScroll: true });
    else if (!entry && (active === status || active === remove)) add.focus({ preventScroll: true });
  }
  const onAdd = () => {
    store.set(seriesId, 'want');
    refresh('已加入书架，标记为想读。');
    status.focus();
  };
  const onStatus = () => {
    if (!READING_STATUSES.some((item) => item.value === status.value)) return;
    store.set(seriesId, status.value);
    refresh(`已标记为${statusLabel(status.value)}。`);
  };
  const onRemove = () => {
    store.remove(seriesId);
    refresh('已移出书架，阅读进度仍会保留。');
    add.focus();
  };
  const onStorage = (event) => { if (event.key === null || event.key === LIBRARY_PREFIX + seriesId) storageRefresh.request(); };
  const onShow = () => refresh();
  add.addEventListener('click', onAdd);
  status.addEventListener('change', onStatus);
  remove.addEventListener('click', onRemove);
  win.addEventListener('storage', onStorage);
  win.addEventListener('pageshow', onShow);
  win.addEventListener('focus', onShow);
  refresh();
  return {
    destroy() {
      storageRefresh.destroy();
      add.removeEventListener('click', onAdd);
      status.removeEventListener('change', onStatus);
      remove.removeEventListener('click', onRemove);
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('pageshow', onShow);
      win.removeEventListener('focus', onShow);
    },
  };
}

/** 即使浏览器存储受损，链接、标题与封面也只使用当前站点目录中的有效数据。 */
export function readLibraryCatalog(node) {
  const catalog = JSON.parse(node.textContent);
  if (!Array.isArray(catalog)) throw new Error('书架目录格式错误');
  const seen = new Set();
  for (const series of catalog) {
    if (!ID.test(series?.id ?? '') || seen.has(series.id) || series.url !== `/${series.id}/`
      || typeof series.title !== 'string' || !Array.isArray(series.authors)
      || !series.authors.every((author) => typeof author === 'string') || !Array.isArray(series.issues)) throw new Error('作品目录格式错误');
    seen.add(series.id);
    if (series.coverUrl !== null) {
      const cover = new URL(series.coverUrl);
      if (cover.protocol !== 'https:' || cover.username || cover.password) throw new Error('封面地址格式错误');
    }
    const chapters = new Set();
    for (const issue of series.issues) {
      if (!ID.test(issue?.id ?? '') || typeof issue.title !== 'string' || !Array.isArray(issue.chapters)) throw new Error('期目录格式错误');
      for (const chapter of issue.chapters) {
        const parts = typeof chapter?.key === 'string' ? chapter.key.split('/') : [];
        if (parts.length !== 3 || !parts.every((part) => ID.test(part)) || parts[0] !== series.id || parts[1] !== issue.id
          || chapter.url !== `/${chapter.key}/` || typeof chapter.title !== 'string' || chapters.has(chapter.key)
          || !Number.isSafeInteger(chapter.pages) || chapter.pages < 1) throw new Error('章节目录格式错误');
        chapters.add(chapter.key);
      }
    }
  }
  return catalog;
}

/** 书架只在本页载入精简目录；搜索与筛选复用内存结果，不逐键重复读取进度。 */
export function mountLibrary(root, options = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const getStorage = options.getStorage ?? (() => win.localStorage);
  const store = options.store ?? createLibraryStore({ getStorage });
  const list = root.querySelector('#library-list');
  const empty = root.querySelector('#library-empty');
  const filter = root.querySelector('#library-filter');
  const search = root.querySelector('#library-search');
  const sort = root.querySelector('#library-sort');
  const count = root.querySelector('#library-count');
  const storageNote = root.querySelector('#library-storage-note');
  const feedback = root.querySelector('#library-feedback');
  const pending = root.querySelector('#library-pending');
  const retry = root.querySelector('#library-retry');
  const discard = root.querySelector('#library-discard');
  const historyList = root.querySelector('#history-list');
  const historyEmpty = root.querySelector('#history-empty');
  const historySearch = root.querySelector('#history-search');
  const historyCount = root.querySelector('#history-count');
  const historyMore = root.querySelector('#history-more');
  const historyRefresh = root.querySelector('#history-refresh');
  let catalog;
  try { catalog = readLibraryCatalog(root.querySelector('#library-catalog')); }
  catch {
    empty.textContent = '书架目录暂时无法读取，请刷新页面重试；也可回首页继续浏览作品。';
    if (historyEmpty) historyEmpty.textContent = '最近阅读目录暂时无法读取，请刷新页面重试。';
    root.setAttribute('aria-busy', 'false');
    return;
  }
  let entries = [];
  let historyRows = [];
  let historyLimit = 20;
  let progressLimited = false;
  let destroyed = false;
  const libraryKeys = new Set(catalog.map((series) => LIBRARY_PREFIX + series.id));
  const progressKeys = new Set(catalog.flatMap((series) => series.issues.flatMap((issue) => issue.chapters.map((chapter) => `gallery:progress:${chapter.key}`))));
  const storageRefresh = createStorageRefresh(win, () => refresh());

  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function card(item) {
    const { series, entry, progress } = item;
    const row = element('li', 'library-item card');
    row.dataset.seriesId = series.id;
    const cover = element('a', 'library-cover');
    cover.href = series.url;
    cover.setAttribute('aria-hidden', 'true');
    cover.tabIndex = -1;
    if (series.coverUrl) {
      const image = element('img');
      image.src = series.coverUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.width = 600;
      image.height = 879;
      cover.append(image);
    } else cover.append(element('span', '', series.title.slice(0, 2)));
    const body = element('div', 'library-item-body');
    const heading = element('h2');
    const title = element('a', '', series.title);
    title.dataset.libraryAction = 'title';
    title.href = series.url;
    heading.append(title);
    body.append(heading);
    if (series.authors.length) body.append(element('p', 'muted', series.authors.join(' / ')));
    const chapters = series.issues.flatMap((issue) => issue.chapters);
    body.append(element('p', 'muted', `${chapters.length} 话 · ${statusLabel(entry.status)}`));
    if (progress) {
      const issue = series.issues.find((issue) => issue.chapters.includes(progress.chapter));
      body.append(element('p', '', `上次读到：${issue.title} · ${progress.chapter.title} · 第 ${progress.n} / ${progress.chapter.pages} 页`));
    } else body.append(element('p', 'muted', chapters.length ? '尚无阅读进度' : '作品尚无章节'));
    const label = element('label', 'library-item-status', '阅读状态');
    const status = element('select');
    status.dataset.libraryStatus = '';
    status.setAttribute('aria-label', `${series.title}的阅读状态`);
    for (const state of READING_STATUSES) {
      const option = element('option', '', state.label);
      option.value = state.value;
      status.append(option);
    }
    status.value = entry.status;
    status.addEventListener('change', () => {
      if (!READING_STATUSES.some((state) => state.value === status.value)) return;
      store.set(series.id, status.value);
      refresh(`《${series.title}》已标记为${statusLabel(status.value)}。`);
      const next = list.querySelector(`[data-series-id="${series.id}"] select`);
      if (next) next.focus();
      else filter.focus();
    });
    label.append(status);
    body.append(label);
    const actions = element('div', 'library-item-actions');
    const chapter = progress?.chapter ?? chapters[0];
    if (chapter) {
      const read = element('a', 'btn btn-primary', progress ? '继续阅读 →' : '开始阅读 →');
      read.dataset.libraryAction = 'read';
      read.href = chapter.url + (progress ? `#p${progress.n}` : '');
      actions.append(read);
    }
    const remove = element('button', 'btn', '移出书架');
    remove.dataset.libraryAction = 'remove';
    remove.type = 'button';
    remove.setAttribute('aria-label', `将${series.title}移出书架`);
    remove.addEventListener('click', () => {
      store.remove(series.id);
      refresh(`《${series.title}》已移出书架，阅读进度仍会保留。`);
      filter.focus();
    });
    actions.append(remove);
    body.append(actions);
    row.append(cover, body);
    return row;
  }

  function render() {
    const query = search.value.trim().normalize('NFKC').toLowerCase();
    const visible = entries.filter(({ series, entry }) => (filter.value === 'all' || entry.status === filter.value)
      && `${series.title} ${series.authors.join(' ')}`.normalize('NFKC').toLowerCase().includes(query));
    if (sort?.value === 'recent') visible.sort((left, right) => Number(Boolean(right.progress)) - Number(Boolean(left.progress))
      || (right.progress?.ts ?? 0) - (left.progress?.ts ?? 0)
      || right.entry.updatedAt - left.entry.updatedAt || left.order - right.order);
    list.replaceChildren(...visible.map(card));
    list.hidden = visible.length === 0;
    empty.hidden = visible.length > 0;
    empty.textContent = entries.length ? '没有符合筛选条件的作品。试试其他状态或清空搜索。'
      : catalog.length ? '书架还是空的。在作品页点击“加入书架”，把想读的故事留在这里。'
        : '当前还没有作品。内容发布后，即可在作品页加入书架。';
    count.textContent = `共 ${entries.length} 部作品 · 显示 ${visible.length} 部`;
    storageNote.hidden = !store.limited && !progressLimited;
    storageNote.textContent = [store.limited ? TEMPORARY_NOTE : '', progressLimited ? PROGRESS_NOTE : ''].filter(Boolean).join(' ');
  }
  function historyCard(item) {
    const { series, issue, chapter, n, ts } = item;
    const row = element('li', 'history-row card card-pad');
    row.dataset.historyKey = chapter.key;
    const heading = element('h3');
    const read = element('a', '', `${series.title} · ${chapter.title}`);
    read.dataset.historyAction = 'read';
    read.href = `${chapter.url}#p${n}`;
    heading.append(read);
    row.append(heading, element('p', 'muted', `${issue.title} · 第 ${n} / ${chapter.pages} 页`));
    const date = new Date(ts);
    const knownTime = ts > 0 && Number.isFinite(date.getTime());
    const time = element('time', 'muted', knownTime ? date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '阅读时间未记录');
    if (knownTime) time.setAttribute('datetime', date.toISOString());
    row.append(time);
    return row;
  }
  function historyFocusVisible(active = doc.activeElement) {
    if (!active || (!historyList?.contains(active) && active !== historyMore)) return false;
    const rect = active.getBoundingClientRect?.();
    return Boolean(rect && rect.height > 0 && rect.bottom > 0 && rect.top < win.innerHeight);
  }
  function renderHistory(hadVisibleFocus = historyFocusVisible()) {
    if (!historyList) return;
    const active = doc.activeElement;
    const focusedKey = historyList.contains(active) ? active.closest('[data-history-key]')?.dataset.historyKey : null;
    const query = (historySearch?.value ?? '').trim().normalize('NFKC').toLowerCase();
    const matches = historyRows.filter(({ series, issue, chapter }) => `${series.title} ${series.authors.join(' ')} ${issue.title} ${chapter.title}`.normalize('NFKC').toLowerCase().includes(query));
    const focusedIndex = focusedKey ? matches.findIndex((item) => item.chapter.key === focusedKey) : -1;
    if (focusedIndex >= historyLimit) historyLimit = Math.ceil((focusedIndex + 1) / 20) * 20;
    historyList.replaceChildren(...matches.slice(0, historyLimit).map(historyCard));
    historyList.hidden = matches.length === 0;
    historyEmpty.hidden = matches.length > 0;
    historyEmpty.textContent = historyRows.length ? '没有匹配的阅读记录。试试其他作品、期名或章节名。'
      : progressLimited ? '阅读记录暂时无法完整读取。可点击“刷新记录”重试；原有记录不会被改动。'
        : catalog.length ? '还没有可用的阅读记录。开始阅读后，可从这里继续，作品无需加入书架。'
          : '当前还没有作品。内容发布后，即可在这里查看最近阅读。';
    historyCount.textContent = `共 ${historyRows.length} 话 · 显示 ${Math.min(historyLimit, matches.length)} / ${matches.length} 话`;
    historyMore.hidden = matches.length <= historyLimit;
    if (focusedKey) {
      const next = historyList.querySelector(`[data-history-key="${focusedKey}"] a`);
      (next ?? historySearch).focus({ preventScroll: !hadVisibleFocus });
    } else if (active === historyMore && historyMore.hidden) historySearch.focus({ preventScroll: !hadVisibleFocus });
  }
  function refresh(message = '') {
    storageRefresh.cancel();
    if (destroyed) return;
    const active = doc.activeElement;
    const historyHadVisibleFocus = historyFocusVisible(active);
    const focusedSeries = list.contains(active) ? active.closest('[data-series-id]')?.dataset.seriesId : null;
    const focusedControl = active?.tagName === 'SELECT' ? 'select'
      : active?.dataset.libraryAction ? `[data-library-action="${active.dataset.libraryAction}"]` : null;
    let storage;
    let storageDenied = false;
    try { storage = getStorage(); } catch { storageDenied = true; }
    const snapshot = storageDenied ? { rows: [], latest: new Map(), limited: true } : readReadingProgress(catalog, storage);
    historyRows = snapshot.rows;
    progressLimited = storageDenied || snapshot.limited;
    entries = catalog.flatMap((series, order) => {
      const entry = store.read(series.id);
      return entry ? [{ series, entry, progress: snapshot.latest.get(series.id) ?? null, order }] : [];
    }).sort((left, right) => right.entry.updatedAt - left.entry.updatedAt || left.order - right.order);
    try {
      options.onSummary?.({
        savedSeries: entries.length, progressSeries: snapshot.latest.size, progressChapters: historyRows.length,
        limited: store.limited || progressLimited, pending: store.hasPending,
      });
    } catch { /* 概览失效不阻断书架、最近阅读及备份保护。 */ }
    feedback.textContent = message;
    if (pending) pending.hidden = !store.hasPending;
    render();
    renderHistory(historyHadVisibleFocus);
    if (focusedSeries && focusedControl) {
      const next = list.querySelector(`[data-series-id="${focusedSeries}"] ${focusedControl}`);
      (next ?? filter).focus({ preventScroll: true });
    }
  }
  const onFilter = () => { if (!destroyed) render(); };
  const onHistoryFilter = () => { if (!destroyed) { historyLimit = 20; renderHistory(); } };
  const onHistoryMore = () => {
    if (destroyed || !historyList) return;
    const previousLimit = historyLimit;
    historyLimit += 20;
    renderHistory();
    const next = historyList.children[previousLimit]?.querySelector('a');
    (next ?? historySearch).focus();
  };
  const onStorage = (event) => {
    if (event.key === null || libraryKeys.has(event.key) || progressKeys.has(event.key)) storageRefresh.request();
  };
  const onShow = () => refresh();
  const returnFromRecovery = () => {
    if (!store.hasPending) {
      search.focus({ preventScroll: true });
      search.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    }
  };
  const onRetry = () => {
    if (destroyed) return;
    const result = store.retryPending();
    refresh(result.persisted ? '本页书架修改已保存。' : '仍有书架修改未能保存，请重试或放弃本页未保存修改。');
    returnFromRecovery();
  };
  const onDiscard = () => {
    if (destroyed) return;
    store.discardPending();
    refresh('已放弃本页未保存的书架修改，重新显示浏览器中已保存的记录。');
    returnFromRecovery();
  };
  filter.addEventListener('change', onFilter);
  search.addEventListener('input', onFilter);
  sort?.addEventListener('change', onFilter);
  historySearch?.addEventListener('input', onHistoryFilter);
  historyMore?.addEventListener('click', onHistoryMore);
  historyRefresh?.addEventListener('click', onShow);
  retry?.addEventListener('click', onRetry);
  discard?.addEventListener('click', onDiscard);
  win.addEventListener('storage', onStorage);
  win.addEventListener('pageshow', onShow);
  win.addEventListener('focus', onShow);
  root.querySelector('[data-library-toolbar]').hidden = false;
  const historyToolbar = root.querySelector('[data-history-toolbar]');
  if (historyToolbar) historyToolbar.hidden = false;
  refresh();
  root.setAttribute('aria-busy', 'false');
  return {
    get hasPending() { return store.hasPending; },
    destroy() {
      destroyed = true;
      storageRefresh.destroy();
      filter.removeEventListener('change', onFilter);
      search.removeEventListener('input', onFilter);
      sort?.removeEventListener('change', onFilter);
      historySearch?.removeEventListener('input', onHistoryFilter);
      historyMore?.removeEventListener('click', onHistoryMore);
      historyRefresh?.removeEventListener('click', onShow);
      retry?.removeEventListener('click', onRetry);
      discard?.removeEventListener('click', onDiscard);
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('pageshow', onShow);
      win.removeEventListener('focus', onShow);
    },
  };
}
