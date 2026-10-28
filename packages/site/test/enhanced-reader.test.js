// 执行真实适配层；DOM 与上游实例只提供已核实的公开契约，控制异步完成顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountEnhancedReader } from '../src/lib/enhanced-reader.js';
import { NOTE_PREFIX } from '../src/lib/bookmarks.js';

const preferenceKey = 'gallery:reader:enhanced';
const chapterKey = 'sample/v/c';
const favoritesKey = `gallery:favorites:${chapterKey}`;
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function element(id = '', interactive = false) {
  const listeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  return {
    id, dataset: {}, hidden: false, checked: false, textContent: '', children: [],
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
    replaceChildren(...children) { this.children = children; },
    closest: () => interactive ? {} : null,
    focus(options) { this.focused = true; this.focusOptions = options; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    listenerCount: (type) => type ? listeners.get(type)?.size ?? 0 : [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0),
    fire(type, properties = {}) {
      const event = { target: this, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; }, ...properties };
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
      return event;
    },
    click() { this.fire('click'); },
  };
}

function fixture({ preferred = false, mode = 'single', hash = '', text = false, page = 3, requestedPage = page, load, storageDenied = false, favorites = [], siteTitle = '测试站点', siteLogo = '/favicon.svg', brandViewer = () => true, scheme, systemDark = false } = {}) {
  const data = new Map([[preferenceKey, String(preferred)], [favoritesKey, JSON.stringify(favorites)]]);
  const writes = [];
  const nodes = new Map(['enhanced-toggle', 'enhanced-viewer', 'enhanced-status', 'text-toggle', 'fullscreen-btn', 'toc-btn', 'settings-btn', 'toc', 'settings']
    .map((id) => [id, element(id)]));
  const document = element('document');
  const window = element('window');
  const timers = new Map();
  let timerId = 0;
  window.location = new URL(`https://example.invalid/sample/v/c/${hash}`);
  window.localStorage = {
    getItem(key) { if (storageDenied) throw new Error('Storage denied'); return data.get(key) ?? null; },
    setItem(key, value) { if (storageDenied) throw new Error('Storage denied'); data.set(key, value); writes.push({ key, value }); },
    removeItem(key) { if (storageDenied) throw new Error('Storage denied'); data.delete(key); writes.push({ key, value: null }); },
  };
  window.queueMicrotask = queueMicrotask;
  window.matchMedia = () => ({ matches: systemDark });
  window.setTimeout = (callback) => { timers.set(++timerId, callback); return timerId; };
  window.clearTimeout = (id) => timers.delete(id);
  document.defaultView = window;
  document.documentElement = { dataset: { ...(scheme === undefined ? {} : { resolvedColorScheme: scheme }) } };
  document.getElementById = (id) => nodes.get(id) ?? null;
  const reader = element('reader');
  reader.ownerDocument = document;
  reader.dataset = { key: chapterKey, title: '测试话', siteTitle, siteLogo };
  const pages = Array.from({ length: 6 }, (_, i) => {
    const pageNode = element(`p${i + 1}`);
    const image = element();
    image.src = `/images/p${i + 1}.jpg`;
    image.alt = `第 ${i + 1} 页`;
    image.setAttribute('width', '700');
    image.setAttribute('height', '1000');
    pageNode.dataset.n = String(i + 1);
    pageNode.querySelector = () => image;
    return pageNode;
  });
  reader.querySelectorAll = () => pages;
  nodes.get('text-toggle').checked = text;
  nodes.get('enhanced-viewer').hidden = true;
  nodes.get('toc').hidden = true;
  nodes.get('settings').hidden = true;
  const subscribers = new Set();
  const coreState = { mode, dir: 'ltr', page, requestedPage };
  const showCalls = [];
  let enhancement = null;
  let refreshCount = 0;
  const publish = () => subscribers.forEach((listener) => listener({ ...coreState }));
  reader.galleryReader = {
    getState: () => ({ ...coreState }),
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    setEnhancement(value) { enhancement = value; },
    showPage(value) {
      showCalls.push(value);
      coreState.page = value;
      coreState.requestedPage = value;
      window.location.hash = `#p${value}`;
      publish();
    },
    refresh() { refreshCount++; publish(); },
  };
  const instances = [];
  const brandingCalls = [];
  let loads = 0;
  const createMangaViewer = (host, options) => {
    const nativeKeys = [];
    const state = { settings: { ...options.settings }, panel: 'none' };
    let current = options.initialPageIndex;
    let favoritePageIds = [];
    const emit = (name, value) => options.events[name]?.(value);
    const keyboard = (event) => nativeKeys.push(event.key);
    window.addEventListener('keydown', keyboard);
    const instance = {
      options, nativeKeys, destroyed: false, goCalls: [], nextCalls: 0, previousCalls: 0,
      panelCalls: [], shareUrl: '', renderedBeforePageChange: [],
      updateResult: null, updateCalls: [],
      getState: () => state,
      getCurrentPageIndex: () => current,
      goToPage(index) {
        this.goCalls.push(index);
        current = index;
        // 上游 store 先触发 renderer.update，之后才发 pageChange。
        this.shareUrl = window.location.href;
        this.renderedBeforePageChange.push(this.shareUrl);
        emit('pageChange', { pageIndex: index });
      },
      setPanel(panel) { this.panelCalls.push(panel); state.panel = panel; this.shareUrl = window.location.href; },
      nextPage() { this.nextCalls++; this.goToPage(current + 1); },
      previousPage() { this.previousCalls++; this.goToPage(current - 1); },
      updateSettings(patch) { this.updateCalls.push(patch); Object.assign(state.settings, patch); return this.updateResult ?? Promise.resolve(); },
      setFavorites(ids) {
        const known = new Set(options.manga.pages.map((entry) => entry.id));
        favoritePageIds = [...new Set(ids.filter((id) => known.has(id)))];
        emit('favoritesChange', { pageIds: favoritePageIds });
      },
      getFavoritePageIds: () => [...favoritePageIds],
      destroy() { this.destroyed = true; window.removeEventListener('keydown', keyboard); host.replaceChildren(); },
      ready: () => emit('ready', { manga: options.manga }),
      emit,
    };
    host.replaceChildren(element('native-viewer'));
    instances.push(instance);
    return instance;
  };
  const api = mountEnhancedReader(reader, {
    loadViewer: () => { loads++; return load ? load({ createMangaViewer }) : { createMangaViewer }; },
    // 这里验证适配层接线；第三方 DOM 的品牌替换由 reader-branding.test.js 执行真实函数。
    brandViewer: (viewer, title, logo) => {
      brandingCalls.push({ viewer, title, logo, active: reader.classList.contains('enhanced-active'), enhancement });
      return brandViewer(viewer, title, logo);
    },
    timeoutMs: 50,
  });
  return {
    api, reader, nodes, window, document, timers, instances, writes, data, showCalls, brandingCalls,
    get loads() { return loads; },
    get enhancement() { return enhancement; },
    get refreshCount() { return refreshCount; },
    get subscriberCount() { return subscribers.size; },
    get active() { return reader.classList.contains('enhanced-active'); },
    choose(checked) { nodes.get('enhanced-toggle').checked = checked; nodes.get('enhanced-toggle').fire('change'); },
    changeState(patch) {
      if ('page' in patch && !('requestedPage' in patch)) coreState.requestedPage = patch.page;
      Object.assign(coreState, patch);
      publish();
    },
    hash(value) { window.location.hash = value; window.fire('hashchange'); },
    text(checked) { nodes.get('text-toggle').checked = checked; nodes.get('text-toggle').fire('change'); },
    scheme(value, detail = { scheme: value }) {
      document.documentElement.dataset.resolvedColorScheme = value;
      window.fire('pagehaven:color-scheme-change', { detail });
    },
    expire() { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); },
    key(key, target = element(), extra = {}) {
      const event = document.fire('keydown', { key, target, ...extra });
      if (!event.stopped) window.fire('keydown', event);
      return event;
    },
  };
}

async function activate(f) {
  f.choose(true);
  await settle();
  const instance = f.instances.at(-1);
  assert.ok(instance, '应创建一个上游实例');
  instance.ready();
  await settle();
  assert.equal(f.active, true);
  return instance;
}

test('增强分页：接管双页模式时恢复归并前的偶数目标页', async () => {
  const f = fixture({ mode: 'double', page: 3, requestedPage: 4 });
  const viewer = await activate(f);
  assert.equal(viewer.options.initialPageIndex, 3);
  assert.equal(viewer.getCurrentPageIndex(), 3);
  assert.equal(f.reader.galleryReader.getState().page, 4);
  viewer.nextPage();
  await settle();
  assert.equal(f.showCalls.at(-1), 5);
  f.api.destroy();
});

for (const [name, options] of [
  ['未选择', {}], ['长条', { preferred: true, mode: 'long' }],
  ['气泡深链', { preferred: true, hash: '#p3b1' }], ['文字层', { preferred: true, text: true }],
]) {
  test(`增强分页：${name}时不加载依赖`, async () => {
    const f = fixture(options);
    await settle();
    assert.equal(f.loads, 0);
    assert.equal(f.enhancement, null);
    assert.equal(f.nodes.get('enhanced-viewer').hidden, true);
    f.api.destroy();
  });
}

test('增强分页：ready 后才接管，沿用核心最新页码并把原生翻页交回核心', async () => {
  const f = fixture();
  f.choose(true);
  await settle();
  const instance = f.instances[0];
  assert.equal(f.enhancement, null);
  assert.equal(f.active, false);
  assert.deepEqual(f.brandingCalls, [], '未 ready 的实例不能先展示上游默认内容');
  assert.equal(instance.options.initialPageIndex, 2);
  assert.equal(instance.options.storage.enabled, false);
  assert.equal(instance.options.lockLayoutMode, true);
  assert.ok(instance.options.hiddenSettings.every((key) => ['locale', 'theme', 'cover', 'direction', 'interval', 'pageMode', 'autoplay', 'viewMode'].includes(key)));
  f.changeState({ page: 5 });
  instance.ready();
  await settle();
  assert.deepEqual(f.brandingCalls, [{ viewer: instance, title: '测试站点', logo: '/favicon.svg', active: false, enhancement: null }], '先完成站点标识替换，再接管阅读');
  assert.equal(f.active, true);
  assert.equal(instance.getCurrentPageIndex(), 4);
  f.enhancement.navigate(1);
  await settle();
  assert.equal(instance.nextCalls, 1);
  assert.equal(f.showCalls.at(-1), 6, '既有核心负责写进度与 hash，适配层仅回报 1-based 页码');
  assert.ok(f.writes.every(({ key }) => !key.startsWith('gallery:progress:')));
  assert.equal(f.timers.size, 0);
  f.api.destroy();
});

test('增强分页：创建时覆盖所有吉祥物区域与收藏说明，站名和图标取自宿主配置', async () => {
  const f = fixture({ siteTitle: '书页小屋', siteLogo: 'https://images.example.org/brand.svg' });
  const instance = await activate(f);
  assert.deepEqual(instance.options.mascot, { default: { src: 'https://images.example.org/brand.svg', alt: '书页小屋' } });
  assert.equal(instance.options.translations['menu.openAbout'], '阅读器说明');
  assert.equal(instance.options.translations['menu.openFavorites'], '页码书签');
  for (const key of ['favorites.description', 'favorites.empty', 'favorites.added', 'favorites.addedUnsaved', 'favorites.remove']) {
    assert.equal(typeof instance.options.translations[key], 'string', `${key} 必须覆盖上游默认文案`);
    assert.doesNotMatch(instance.options.translations[key], /超喜欢|comimi/i);
  }
  assert.equal(f.brandingCalls[0].title, '书页小屋');
  assert.equal(f.brandingCalls[0].logo, 'https://images.example.org/brand.svg');
  f.api.destroy();
});

test('增强分页：初始配色取宿主已解析值，缺失时再取明确偏好或系统', async () => {
  for (const [options, preference, expected] of [
    [{ scheme: 'dark', systemDark: false }, undefined, 'dark'],
    [{ scheme: 'light', systemDark: true }, undefined, 'light'],
    [{ systemDark: true }, 'light', 'light'],
    [{ systemDark: false }, 'dark', 'dark'],
    [{ scheme: 'invalid', systemDark: true }, 'system', 'dark'],
    [{ systemDark: false }, undefined, 'light'],
  ]) {
    const f = fixture(options);
    if (preference !== undefined) f.document.documentElement.dataset.colorScheme = preference;
    const instance = await activate(f);
    assert.equal(instance.options.settings.theme, expected);
    assert.equal(instance.getState().settings.theme, expected);
    assert.ok(instance.options.hiddenSettings.includes('theme'), '组件自身主题设置只读，避免与站点偏好冲突');
    f.api.destroy();
  }
  const f = fixture();
  f.window.matchMedia = () => { throw new Error('Media query unavailable'); };
  const instance = await activate(f);
  assert.equal(instance.options.settings.theme, 'light', '旧环境的系统探测失败仍可初始化');
  f.api.destroy();
});

test('增强分页：配色在模块加载中及 ready 前变化时最终同步最新主题', async () => {
  const loading = deferred();
  let module;
  const f = fixture({ preferred: true, scheme: 'light', load: (value) => { module = value; return loading.promise; } });
  await settle();
  f.scheme('dark');
  loading.resolve(module);
  await settle();
  const instance = f.instances[0];
  assert.equal(instance.options.settings.theme, 'dark', '延迟 import 不能使用请求开始时的旧主题');
  assert.equal(f.active, false);
  f.scheme('light');
  await settle();
  assert.equal(instance.updateCalls.length, 0, '未 ready 时不提前更新组件');
  instance.ready();
  await settle();
  assert.equal(f.active, true);
  assert.equal(instance.getState().settings.theme, 'light');
  assert.equal(f.instances.length, 1);
  f.api.destroy();
});

test('增强分页：就地切换主题不重建组件、不改页码收藏或写入个人记录', async () => {
  const f = fixture({ scheme: 'light', page: 4, favorites: [`${chapterKey}/p2`] });
  f.data.set(NOTE_PREFIX + `${chapterKey}/p2`, JSON.stringify({ version: 1, note: '保留备注', updatedAt: 10 }));
  const instance = await activate(f);
  const before = { data: new Map(f.data), writes: [...f.writes], showCalls: [...f.showCalls], page: instance.getCurrentPageIndex() };
  for (const theme of ['dark', 'light', 'dark']) {
    f.scheme(theme, { scheme: 'invalid' });
    await settle();
    assert.equal(instance.getState().settings.theme, theme, '无效事件详情应安全取宿主已解析配色');
  }
  assert.equal(f.instances.length, 1);
  assert.equal(instance.destroyed, false);
  assert.equal(instance.getCurrentPageIndex(), before.page);
  assert.deepEqual(instance.getFavoritePageIds(), [`${chapterKey}/p2`]);
  assert.deepEqual(f.data, before.data);
  assert.deepEqual(f.writes, before.writes);
  assert.deepEqual(f.showCalls, before.showCalls);
  const updates = instance.updateCalls.length;
  f.scheme('dark');
  await settle();
  assert.equal(instance.updateCalls.length, updates, '相同主题事件不产生重复设置更新');
  f.api.destroy();
  assert.equal(f.window.listenerCount('pagehaven:color-scheme-change'), 0);
  f.scheme('light');
  await settle();
  assert.equal(instance.updateCalls.length, updates, '销毁后不再向旧实例同步配色');
});

test('增强分页：主题同步拒绝时恢复标准阅读器，旧更新拒绝不影响后来实例', async () => {
  const f = fixture({ scheme: 'light', page: 4, favorites: [`${chapterKey}/p2`] });
  const first = await activate(f);
  first.updateResult = Promise.reject(new Error('Theme update failed'));
  f.scheme('dark');
  await settle();
  assert.equal(first.destroyed, true);
  assert.equal(f.active, false);
  assert.equal(f.reader.galleryReader.getState().page, 4);
  assert.equal(f.nodes.get('enhanced-viewer').hidden, true);
  assert.match(f.nodes.get('enhanced-status').textContent, /标准阅读器/);
  assert.equal(f.data.get(favoritesKey), JSON.stringify([`${chapterKey}/p2`]));
  const second = await activate(f);
  assert.equal(second.options.settings.theme, 'dark');
  const update = deferred();
  second.updateResult = update.promise;
  f.scheme('light');
  await settle();
  f.choose(false);
  await settle();
  const third = await activate(f);
  update.reject(new Error('Stale theme update failed'));
  await settle();
  assert.equal(second.destroyed, true);
  assert.equal(third.destroyed, false);
  assert.equal(third.getState().settings.theme, 'light');
  assert.equal(f.active, true);
  f.api.destroy();
});

for (const reason of ['不支持的内容结构', '品牌替换异常']) {
  test(`增强分页：${reason}在接管前恢复标准阅读器且可重试`, async () => {
    let rejected = true;
    const f = fixture({ brandViewer: () => {
      if (!rejected) return true;
      if (reason === '品牌替换异常') throw new Error('Unavailable branding structure');
      return false;
    } });
    f.choose(true);
    await settle();
    const first = f.instances[0];
    first.ready();
    await settle();
    assert.equal(first.destroyed, true);
    assert.equal(f.enhancement, null);
    assert.equal(f.active, false);
    assert.equal(f.nodes.get('enhanced-toggle').checked, false);
    assert.equal(f.nodes.get('enhanced-viewer').hidden, true);
    assert.match(f.nodes.get('enhanced-status').textContent, /标准阅读器/);
    assert.equal(f.window.listenerCount('keydown'), 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.brandingCalls.length, 1);
    rejected = false;
    await activate(f);
    assert.equal(f.brandingCalls.length, 2);
    f.api.destroy();
  });
}

test('增强分页：加载阶段不把键盘同时交给上游；接管后协调空格与隐藏快捷键', async () => {
  const f = fixture();
  f.choose(true);
  await settle();
  const instance = f.instances[0];
  f.key('ArrowRight');
  assert.deepEqual(instance.nativeKeys, []);
  instance.ready();
  await settle();
  const space = f.key(' ');
  assert.equal(space.defaultPrevented, true);
  assert.equal(instance.nextCalls, 1);
  for (const key of ['p', 'P', 'c', 'C', 'a', 'A']) assert.equal(f.key(key).stopped, true);
  let fullscreen = 0, toc = 0;
  f.nodes.get('fullscreen-btn').addEventListener('click', () => fullscreen++);
  f.nodes.get('toc-btn').addEventListener('click', () => toc++);
  f.key('F'); f.key('t');
  assert.equal(fullscreen, 1);
  assert.equal(toc, 1);
  const buttonSpace = f.key(' ', element('button', true));
  assert.equal(buttonSpace.defaultPrevented, false, '按钮的空格应保留原生点击');
  assert.equal(f.key('p', element(), { ctrlKey: true }).defaultPrevented, false, '保留浏览器组合键默认行为');
  assert.equal(instance.nextCalls, 1);
  f.key('ArrowRight');
  assert.deepEqual(instance.nativeKeys, ['ArrowRight']);
  f.api.destroy();
});

for (const panel of ['toc', 'settings']) {
  test(`增强分页：${panel} 输入框内 Escape 关闭外部面板并返回对应按钮`, async () => {
    const f = fixture();
    const instance = await activate(f);
    instance.setPanel('share');
    f.nodes.get(panel).hidden = false;
    const event = f.key('Escape', element('panel-input', true));
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
    assert.equal(f.nodes.get(panel).hidden, true);
    assert.equal(f.nodes.get(`${panel}-btn`).focused, true);
    assert.deepEqual(f.nodes.get(`${panel}-btn`).focusOptions, { preventScroll: true });
    assert.deepEqual(instance.nativeKeys, [], '同一次 Escape 不能顺便关闭上游面板');
    assert.equal(instance.getState().panel, 'share');
    assert.equal(instance.nextCalls, 0);
    f.api.destroy();
  });
}

test('增强分页：外部面板打开或交互控件聚焦时，翻页快捷键不会到达上游', async () => {
  const f = fixture();
  const instance = await activate(f);
  const page = f.reader.galleryReader.getState().page;
  for (const panel of ['toc', 'settings']) {
    f.nodes.get(panel).hidden = false;
    for (const target of [element('body'), element('filter', true), element('current-chapter', true)]) {
      for (const key of ['ArrowLeft', 'ArrowRight', ' ', 'PageDown']) {
        const event = f.key(key, target);
        assert.equal(event.stopped, true);
        assert.equal(event.defaultPrevented, false, '不阻止输入、链接与按钮的默认键盘操作');
      }
    }
    f.nodes.get(panel).hidden = true;
  }
  for (const key of ['ArrowLeft', 'ArrowRight', ' ']) f.key(key, element('page-input', true));
  assert.deepEqual(instance.nativeKeys, []);
  assert.equal(instance.nextCalls, 0);
  assert.equal(f.reader.galleryReader.getState().page, page);
  f.key('ArrowRight');
  assert.deepEqual(instance.nativeKeys, ['ArrowRight'], '退出外部面板且焦点离开控件后恢复上游快捷键');
  f.api.destroy();
});

test('增强分页：只有原生面板打开时 Escape 继续交给上游，包括输入框焦点', async () => {
  const f = fixture();
  const instance = await activate(f);
  instance.setPanel('share');
  for (const target of [element('body'), element('native-input', true)]) {
    const event = f.key('Escape', target);
    assert.equal(event.stopped, false);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(instance.nativeKeys, ['Escape', 'Escape']);
  assert.deepEqual(instance.panelCalls, ['share'], '适配层不替上游切换其原生面板');
  assert.equal(f.nodes.get('toc-btn').focused, undefined);
  assert.equal(f.nodes.get('settings-btn').focused, undefined);
  f.api.destroy();
});

test('增强分页：外部翻页在核心更新 hash 后刷新已打开的分享面板', async () => {
  const f = fixture({ page: 3 });
  const instance = await activate(f);
  instance.setPanel('share');
  assert.equal(new URL(instance.shareUrl).hash, '#p3');
  f.enhancement.navigate(1);
  assert.equal(new URL(instance.renderedBeforePageChange.at(-1)).hash, '#p3', '复现上游先用旧 URL 绘制分享框');
  assert.equal(new URL(instance.shareUrl).hash, '#p4');
  assert.equal(new URL(instance.shareUrl).search, '', '保持原有 hash 深链，不另写 query');
  assert.deepEqual(instance.panelCalls, ['share', 'share']);
  await settle();
  assert.equal(instance.panelCalls.length, 2, '同步不能引起重复刷新循环');

  for (const panel of ['settings', 'none']) {
    instance.setPanel(panel);
    const count = instance.panelCalls.length;
    f.enhancement.navigate(1);
    await settle();
    assert.equal(instance.panelCalls.length, count, '分享未打开时无需刷新面板');
    assert.equal(instance.getState().panel, panel, '不能打开分享或切走当前面板');
  }
  f.api.destroy();
});

for (const reason of ['退出', '长条', '销毁']) {
  test(`增强分页：import 未完成时${reason}取消接管`, async () => {
    const loading = deferred();
    let module;
    const f = fixture({ preferred: true, load: (value) => { module = value; return loading.promise; } });
    await settle();
    if (reason === '退出') f.choose(false);
    if (reason === '长条') f.changeState({ mode: 'long' });
    if (reason === '销毁') f.api.destroy();
    await settle();
    loading.resolve(module);
    await settle();
    assert.equal(f.instances.length, 0);
    assert.equal(f.enhancement, null);
    assert.equal(f.timers.size, 0);
    f.api.destroy();
  });
}

test('增强分页：ready 前打开文字层销毁实例，过期 ready 不会重新接管', async () => {
  const f = fixture({ preferred: true });
  await settle();
  const instance = f.instances[0];
  f.text(true);
  await settle();
  instance.ready();
  await settle();
  assert.equal(instance.destroyed, true);
  assert.equal(f.active, false);
  assert.equal(f.enhancement, null);
  assert.equal(f.window.listenerCount('keydown'), 0);
  f.api.destroy();
});

for (const reason of ['import 拒绝', 'ready 超时', '图片失败']) {
  test(`增强分页：${reason}恢复标准阅读器且可重试`, async () => {
    let rejectImport = reason === 'import 拒绝';
    const f = fixture({ preferred: true, load: (module) => rejectImport ? Promise.reject(new Error('Unavailable')) : module });
    await settle();
    if (reason === 'ready 超时') f.expire();
    if (reason === '图片失败') { f.instances[0].ready(); f.instances[0].emit('pageLoadError', { pageIndex: 2 }); }
    await settle();
    assert.equal(f.enhancement, null);
    assert.equal(f.active, false);
    assert.equal(f.nodes.get('enhanced-toggle').checked, false);
    assert.equal(f.nodes.get('enhanced-viewer').hidden, true);
    assert.match(f.nodes.get('enhanced-status').textContent, /标准阅读器/);
    assert.equal(f.window.listenerCount('keydown'), 0);
    assert.equal(f.timers.size, 0);
    rejectImport = false;
    await activate(f);
    f.api.destroy();
  });
}

test('增强分页：旧实例迟到的设置失败不能关闭新实例', async () => {
  const f = fixture();
  const first = await activate(f);
  const update = deferred();
  first.updateResult = update.promise;
  f.changeState({ dir: 'rtl' });
  await settle();
  f.choose(false);
  await settle();
  const second = await activate(f);
  update.reject(new Error('Old update failed'));
  await settle();
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, false);
  assert.equal(f.active, true);
  assert.equal(f.nodes.get('enhanced-toggle').checked, true);
  f.api.destroy();
});

test('增强分页：气泡 hash 立即恢复标准阅读，移除气泡后可重新启用', async () => {
  const f = fixture();
  const first = await activate(f);
  f.hash('#p4b2');
  await settle();
  assert.equal(first.destroyed, true);
  assert.equal(f.active, false);
  assert.equal(f.nodes.get('enhanced-toggle').checked, true, '暂停保留使用者选择');
  f.hash('#p4');
  await settle();
  f.instances.at(-1).ready();
  await settle();
  assert.equal(f.active, true);
  f.api.destroy();
});

test('增强分页：收藏恢复不覆盖旧记录，只在用户变更后写独立本话键', async () => {
  const f = fixture({ favorites: [`${chapterKey}/p4`, 'obsolete-page', 10] });
  const instance = await activate(f);
  assert.deepEqual(instance.getFavoritePageIds(), [`${chapterKey}/p4`]);
  assert.equal(f.writes.filter(({ key }) => key === favoritesKey).length, 0);
  instance.setFavorites([`${chapterKey}/p5`]);
  assert.deepEqual(JSON.parse(f.data.get(favoritesKey)), [`${chapterKey}/p5`]);
  f.api.destroy();
});

test('增强分页：收藏读写与偏好存储被拒绝仍可阅读', async () => {
  const f = fixture({ storageDenied: true });
  const instance = await activate(f);
  instance.setFavorites([`${chapterKey}/p3`]);
  await settle();
  assert.equal(f.active, true);
  assert.match(f.nodes.get('enhanced-status').textContent, /当前页面/);
  f.enhancement.navigate(1);
  await settle();
  assert.equal(f.showCalls.at(-1), 4);
  assert.equal(f.active, true);
  f.api.destroy();
});

test('增强分页：普通阅读器书签与备注变更同步到收藏，不回写或循环通知', async () => {
  const f = fixture();
  const instance = await activate(f);
  assert.equal(f.writes.filter(({ key }) => key === favoritesKey).length, 0);
  const store = f.reader.galleryBookmarkStore;
  store.set(chapterKey, 6, 2, '稍后重读');
  assert.deepEqual(instance.getFavoritePageIds(), [`${chapterKey}/p2`]);
  assert.equal(f.writes.filter(({ key }) => key === favoritesKey).length, 1);
  store.set(chapterKey, 6, 2, '补充备注');
  assert.deepEqual(store.list(chapterKey, 6).map(({ note }) => note), ['补充备注']);
  const before = f.writes.length;
  instance.emit('favoritesChange');
  await settle();
  assert.equal(f.writes.length, before, '相同收藏集合的迟到回调不能重新落盘');
  f.api.destroy();
  store.set(chapterKey, 6, 3, '销毁后只更新数据');
  assert.deepEqual(instance.getFavoritePageIds(), [`${chapterKey}/p2`], '销毁后解绑书签订阅');
});

test('增强分页：外部收藏与页面恢复同步不落盘，无关事件不改变收藏', async () => {
  const f = fixture({ favorites: [`${chapterKey}/p1`] });
  const instance = await activate(f);
  const before = f.writes.length;
  f.data.set(favoritesKey, JSON.stringify([`${chapterKey}/p4`]));
  f.window.fire('storage', { key: 'unrelated' });
  assert.deepEqual(instance.getFavoritePageIds(), [`${chapterKey}/p1`]);
  f.window.fire('storage', { key: favoritesKey });
  assert.deepEqual(instance.getFavoritePageIds(), [`${chapterKey}/p4`]);
  f.data.set(favoritesKey, JSON.stringify([`${chapterKey}/p5`]));
  f.window.fire('pageshow', { persisted: true });
  await settle();
  assert.deepEqual(instance.getFavoritePageIds(), [`${chapterKey}/p5`]);
  f.data.delete(favoritesKey);
  f.window.fire('storage', { key: null });
  assert.deepEqual(instance.getFavoritePageIds(), []);
  assert.equal(f.writes.length, before, '同步只是读取，不能覆盖原收藏或备注');
  f.api.destroy();
});

test('增强分页：取消一页收藏删除其备注，保留其他页备注与阅读记录', async () => {
  const f = fixture({ favorites: [`${chapterKey}/p2`, `${chapterKey}/p4`] });
  const noteKey = (n) => `${NOTE_PREFIX}${chapterKey}/p${n}`;
  const note = (value) => JSON.stringify({ version: 1, note: value, updatedAt: 10 });
  f.data.set(noteKey(2), note('取消这一页'));
  f.data.set(noteKey(4), note('保留这一页'));
  f.data.set(`gallery:progress:${chapterKey}`, '原阅读记录');
  f.data.set('gallery:library:sample', '原书架状态');
  const instance = await activate(f);
  instance.setFavorites([`${chapterKey}/p4`]);
  assert.equal(f.data.has(noteKey(2)), false);
  assert.equal(f.data.get(noteKey(4)), note('保留这一页'));
  assert.equal(f.data.get(`gallery:progress:${chapterKey}`), '原阅读记录');
  assert.equal(f.data.get('gallery:library:sample'), '原书架状态');
  assert.deepEqual(f.reader.galleryBookmarkStore.list(chapterKey, 6).map(({ n, note }) => [n, note]), [[4, '保留这一页']]);
  f.api.destroy();
});

test('增强分页：存储受限时切换到标准模式再启用仍保留当前页临时书签', async () => {
  const f = fixture({ storageDenied: true });
  const first = await activate(f);
  first.setFavorites([`${chapterKey}/p2`]);
  f.reader.galleryBookmarkStore.set(chapterKey, 6, 3, '本页临时备注');
  assert.deepEqual(first.getFavoritePageIds(), [`${chapterKey}/p2`, `${chapterKey}/p3`]);
  f.choose(false);
  await settle();
  const second = await activate(f);
  assert.deepEqual(second.getFavoritePageIds(), [`${chapterKey}/p2`, `${chapterKey}/p3`]);
  assert.equal(f.reader.galleryBookmarkStore.list(chapterKey, 6).find(({ n }) => n === 3).note, '本页临时备注');
  f.api.destroy();
});

test('增强分页：bfcache 离开只暂停，返回重新初始化且不重复监听', async () => {
  const f = fixture();
  const first = await activate(f);
  f.window.fire('pagehide', { persisted: true });
  await settle();
  assert.equal(first.destroyed, true);
  assert.equal(f.refreshCount, 0, '离开时不能刷新核心覆盖 hash 或进度');
  assert.equal(f.window.listenerCount('keydown'), 0);
  assert.equal(f.nodes.get('enhanced-toggle').listenerCount('change'), 1);
  f.window.fire('pageshow', { persisted: true });
  await settle();
  assert.equal(f.instances.length, 2);
  f.instances[1].ready();
  await settle();
  assert.equal(f.active, true);
  assert.equal(f.window.listenerCount('keydown'), 1);
  f.window.fire('pageshow', { persisted: true });
  await settle();
  assert.equal(f.instances.length, 2);
  f.api.destroy();
});

test('增强分页：销毁取消实例、待执行任务、计时器和所有适配层监听', async () => {
  const f = fixture();
  const instance = await activate(f);
  f.changeState({ dir: 'rtl' });
  f.api.destroy();
  f.api.destroy();
  await settle();
  assert.equal(instance.destroyed, true);
  assert.equal(f.subscriberCount, 0);
  assert.equal(f.document.listenerCount(), 0);
  assert.equal(f.window.listenerCount(), 0);
  assert.equal(f.nodes.get('enhanced-toggle').listenerCount(), 0);
  assert.equal(f.nodes.get('text-toggle').listenerCount(), 0);
  assert.equal(f.timers.size, 0);
  f.choose(true);
  f.window.fire('pageshow', { persisted: true });
  await settle();
  assert.equal(f.instances.length, 1);
});
