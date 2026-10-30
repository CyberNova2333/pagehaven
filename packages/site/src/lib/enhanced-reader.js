// 可选分页组件只负责呈现；原阅读器仍统一管理模式、hash 与首页读取的进度。
import { FAVORITES_PREFIX, getReaderBookmarkStore } from './bookmarks.js';
import { readerBrandOptions, applyReaderBranding } from './reader-branding.js';
import { createStorageRefresh } from './storage-refresh.js';

export function mountEnhancedReader(reader, {
  loadViewer = () => import('@yui540/comimi'),
  timeoutMs = 12000,
  brandViewer = (viewer, siteTitle, siteLogo) => applyReaderBranding(viewer.getElement(), siteTitle, siteLogo),
} = {}) {
  const doc = reader.ownerDocument;
  const win = doc.defaultView;
  const core = reader.galleryReader;
  const toggle = doc.getElementById('enhanced-toggle');
  const host = doc.getElementById('enhanced-viewer');
  const status = doc.getElementById('enhanced-status');
  const textToggle = doc.getElementById('text-toggle');
  if (!core || !toggle || !host || !status) return null;

  const preferenceKey = 'gallery:reader:enhanced';
  const chapterKey = reader.dataset.key;
  const favoritesKey = FAVORITES_PREFIX + chapterKey;
  const bookmarkStore = getReaderBookmarkStore(reader);
  const pages = [...reader.querySelectorAll('.page')].map((page) => {
    const img = page.querySelector('img');
    return {
      id: `${reader.dataset.key}/p${page.dataset.n}`,
      type: 'image', src: img.src, alt: img.alt,
      width: Number(img.getAttribute('width')), height: Number(img.getAttribute('height')),
      label: `第 ${page.dataset.n} 页`,
    };
  });
  let preferred = false;
  try { preferred = win.localStorage.getItem(preferenceKey) === 'true'; } catch { /* 隐私模式仍可使用。 */ }
  toggle.checked = preferred;
  let viewer = null;
  let active = false;
  let pending = false;
  let generation = 0;
  let timer;
  let queued = false;
  let disposed = false;
  let suspended = false;
  let failure = '';
  let favoritesReady = false;
  let syncedFavorites = [];
  const favoritesRefresh = createStorageRefresh(win, () => syncFavorites());
  const colorSchemeEvent = 'pagehaven:color-scheme-change';
  const validTheme = (value) => value === 'light' || value === 'dark';
  function resolvedTheme(event) {
    if (validTheme(event?.detail?.scheme)) return event.detail.scheme;
    const root = doc.documentElement;
    if (validTheme(root?.dataset.resolvedColorScheme)) return root.dataset.resolvedColorScheme;
    if (validTheme(root?.dataset.colorScheme)) return root.dataset.colorScheme;
    try { return win.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch { return 'light'; }
  }
  let theme = resolvedTheme();

  const savedFavoriteIds = () => bookmarkStore.ids(chapterKey, pages.length);
  const sameFavorites = (left, right) => {
    const sortedRight = [...right].sort();
    return left.length === right.length && [...left].sort().every((id, index) => id === sortedRight[index]);
  };
  function syncFavorites() {
    favoritesRefresh.cancel();
    if (!active || !viewer || !favoritesReady || disposed) return;
    const favorites = savedFavoriteIds();
    syncedFavorites = [...favorites];
    if (sameFavorites(favorites, viewer.getFavoritePageIds())) return;
    // 上游 setFavorites 也会回报 favoritesChange；恢复和同步都不能变成一次用户写入。
    favoritesReady = false;
    try { viewer.setFavorites(favorites); } finally { favoritesReady = true; }
  }

  function message(value) {
    status.textContent = value;
    status.hidden = !value;
  }
  function pauseReason() {
    if (core.getState().mode === 'long') return '长条模式使用标准阅读器。';
    if (textToggle?.checked || /^#p\d+b\d+$/.test(win.location.hash)) return '文字显示与台词定位使用标准阅读器。';
    return '';
  }
  function wantsViewer() { return preferred && !pauseReason() && !disposed && !suspended; }
  function remember() {
    try { win.localStorage.setItem(preferenceKey, String(preferred)); } catch { /* 不影响当前选择。 */ }
  }
  function deactivate({ refresh = true } = {}) {
    generation++;
    win.clearTimeout(timer);
    pending = false;
    const wasActive = active;
    active = false;
    favoritesReady = false;
    syncedFavorites = [];
    favoritesRefresh.cancel();
    core.setEnhancement(null);
    const previous = viewer;
    viewer = null;
    try { previous?.destroy(); } catch { /* 清理失败也必须恢复标准阅读器。 */ } finally {
      host.replaceChildren();
      host.hidden = true;
      host.removeAttribute('data-loading');
      reader.classList.remove('enhanced-active');
      if (wasActive && refresh) core.refresh();
    }
  }
  function fail() {
    preferred = false;
    toggle.checked = false;
    remember();
    failure = '增强分页暂不可用，已使用标准阅读器。可重新勾选重试。';
    deactivate();
    message(failure);
  }
  function schedule() {
    if (queued || disposed) return;
    queued = true;
    win.queueMicrotask(() => {
      queued = false;
      if (!disposed) sync();
    });
  }
  function sync() {
    if (!wantsViewer()) {
      if (viewer || pending) deactivate();
      message(preferred ? pauseReason() : failure);
      return;
    }
    if (active) {
      const state = core.getState();
      const settings = viewer.getState().settings;
      const mode = state.mode === 'double' ? 'spread' : 'single';
      if (settings.pageTurnMode !== mode || settings.readingDirection !== state.dir || settings.theme !== theme) {
        const ticket = generation;
        viewer.updateSettings({ pageTurnMode: mode, readingDirection: state.dir, theme }).catch(() => {
          if (ticket === generation) fail();
        });
      }
      if (viewer.getCurrentPageIndex() !== state.page - 1) viewer.goToPage(state.page - 1);
      return;
    }
    if (pending) return;
    pending = true;
    const ticket = ++generation;
    message('正在加载增强分页，标准阅读器仍可使用…');
    timer = win.setTimeout(() => { if (ticket === generation) fail(); }, timeoutMs);
    Promise.resolve().then(loadViewer).then(({ createMangaViewer }) => {
      if (ticket !== generation || !wantsViewer()) return;
      const state = core.getState();
      theme = resolvedTheme();
      favoritesReady = false;
      host.hidden = false;
      host.setAttribute('data-loading', '');
      viewer = createMangaViewer(host, {
        manga: { id: reader.dataset.key, title: reader.dataset.title, pages },
        initialPageIndex: (state.requestedPage ?? state.page) - 1,
        locale: 'zh-CN',
        ...readerBrandOptions(reader.dataset.siteTitle || '漫画阅读器', reader.dataset.siteLogo || '/favicon.svg'),
        storage: { enabled: false },
        lockLayoutMode: true,
        hiddenSettings: ['locale', 'theme', 'cover', 'direction', 'interval', 'pageMode', 'autoplay', 'viewMode'],
        settings: { locale: 'zh-CN', hasCover: false, layoutMode: 'inline', theme,
          pageTurnMode: state.mode === 'double' ? 'spread' : 'single', readingDirection: state.dir },
        events: {
          ready: () => {
            if (ticket !== generation || !wantsViewer()) { schedule(); return; }
            try {
              if (!brandViewer(viewer, reader.dataset.siteTitle || '漫画阅读器', reader.dataset.siteLogo || '/favicon.svg')) { fail(); return; }
            } catch { fail(); return; }
            win.clearTimeout(timer);
            pending = false;
            active = true;
            core.setEnhancement({ navigate: (delta) => delta > 0 ? viewer.nextPage() : viewer.previousPage() });
            const latest = core.getState();
            core.showPage(latest.requestedPage ?? latest.page);
            host.removeAttribute('data-loading');
            reader.classList.add('enhanced-active');
            message('');
            favoritesReady = true;
            syncFavorites();
            // 加载期间仍可在标准阅读器翻页，取最新页码而非请求开始时的快照。
            sync();
          },
          pageChange: ({ pageIndex }) => {
            if (!active || ticket !== generation) return;
            core.showPage(pageIndex + 1);
            // 上游先绘制面板再回报翻页；等核心写入新 hash 后刷新已打开的分享链接。
            if (viewer.getState().panel === 'share') viewer.setPanel('share');
          },
          pageLoadError: () => { if (ticket === generation) fail(); },
          favoritesChange: () => {
            if (!active || !favoritesReady || ticket !== generation) return;
            const favorites = viewer.getFavoritePageIds();
            if (sameFavorites(syncedFavorites, favorites)) return;
            const previous = syncedFavorites;
            syncedFavorites = [...favorites];
            const result = bookmarkStore.updateFavorites(chapterKey, pages.length, previous, favorites);
            message(result.persisted ? '' : '书签修改未能完整保存，暂留在当前页面；离开或刷新页面后可能丢失。');
          },
        },
      });
    }).catch(() => { if (ticket === generation) fail(); });
  }
  function changePreference() {
    preferred = toggle.checked;
    failure = '';
    remember();
    schedule();
  }
  function keydown(event) {
    // 上游在 ready 之前已绑定 window；加载阶段仍由标准阅读器接收 document 按键。
    if (!active) { if (viewer) event.stopPropagation(); return; }
    const key = event.key.toLowerCase();
    const toc = doc.getElementById('toc');
    const settings = doc.getElementById('settings');
    const panel = toc && !toc.hidden ? 'toc' : settings && !settings.hidden ? 'settings' : null;
    if (key === 'escape') {
      if (panel) {
        event.preventDefault();
        event.stopPropagation();
        if (toc) toc.hidden = true;
        if (settings) settings.hidden = true;
        doc.getElementById(`${panel}-btn`)?.focus({ preventScroll: true });
      }
      // 外部面板未打开时，保留上游自身面板的 Escape，包括其输入框获得焦点时。
      return;
    }
    const interactive = event.target?.closest('input, textarea, select, button, a, [contenteditable]');
    // 上游快捷键监听 window；目录打开或输入控件聚焦时不翻动背景漫画，保留控件默认操作。
    if (panel || interactive || event.ctrlKey || event.metaKey || event.altKey) { event.stopPropagation(); return; }
    if (key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      viewer.nextPage();
    } else if (key === 'f' || key === 't') {
      event.preventDefault();
      event.stopPropagation();
      doc.getElementById(key === 'f' ? 'fullscreen-btn' : 'toc-btn')?.click();
    } else if (key === 'p' || key === 'c' || key === 'a') {
      // 隐藏的原生模式、封面和自动播放也不能通过快捷键改变站点设置。
      event.preventDefault();
      event.stopPropagation();
    }
  }
  const unsubscribe = core.subscribe(schedule);
  const unsubscribeBookmarks = bookmarkStore.subscribe(({ chapterKey: changed }) => {
    if (changed === chapterKey) syncFavorites();
  });
  function onStorage(event) {
    if (event.key === null || event.key === favoritesKey) favoritesRefresh.request();
  }
  function onColorScheme(event) {
    theme = resolvedTheme(event);
    schedule();
  }
  toggle.addEventListener('change', changePreference);
  textToggle?.addEventListener('change', schedule);
  win.addEventListener('hashchange', schedule);
  win.addEventListener('storage', onStorage);
  win.addEventListener('focus', syncFavorites);
  win.addEventListener(colorSchemeEvent, onColorScheme);
  doc.addEventListener('keydown', keydown);
  function suspend() {
    suspended = true;
    deactivate({ refresh: false });
  }
  function resume() {
    suspended = false;
    theme = resolvedTheme();
    syncFavorites();
    schedule();
  }
  function destroy() {
    if (disposed) return;
    disposed = true;
    favoritesRefresh.destroy();
    unsubscribe();
    unsubscribeBookmarks();
    toggle.removeEventListener('change', changePreference);
    textToggle?.removeEventListener('change', schedule);
    win.removeEventListener('hashchange', schedule);
    win.removeEventListener('storage', onStorage);
    win.removeEventListener('focus', syncFavorites);
    win.removeEventListener(colorSchemeEvent, onColorScheme);
    doc.removeEventListener('keydown', keydown);
    win.removeEventListener('pagehide', suspend);
    win.removeEventListener('pageshow', resume);
    deactivate();
  }
  win.addEventListener('pagehide', suspend);
  win.addEventListener('pageshow', resume);
  schedule();
  return { destroy };
}
