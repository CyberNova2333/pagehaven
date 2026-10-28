import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountChapterToc, parseChapterIndex } from '../src/lib/chapter-toc.js';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function index() {
  return {
    id: 'sample', title: '作品', issues: [
      { id: 'v1', title: '第一期', number: 1, chapters: [
        { id: 'c1', number: 1, title: '初遇', key: 'sample/v1/c1', url: '/sample/v1/c1/', pages: 5 },
        { id: 'c2', number: 2, title: '归途', key: 'sample/v1/c2', url: '/sample/v1/c2/', pages: 8 },
      ] },
      { id: 'v2', title: '第二期', number: 2, chapters: [
        { id: 'c3', number: 3, title: '<img src=x onerror=alert(1)>', key: 'sample/v2/c3', url: '/sample/v2/c3/', pages: 4 },
      ] },
    ],
  };
}
const response = (data = index()) => ({ ok: true, json: async () => data });

// DOM 桩只提供标准契约；所有加载、校验、渲染和清理均执行生产模块。
function element(tag = '') {
  const listeners = new Map();
  const attributes = new Map();
  const observers = new Set();
  let hidden = false;
  return {
    tag, id: '', dataset: {}, children: [], value: '', textContent: '', scrollTop: 0, clientHeight: 100,
    get hidden() { return hidden; },
    set hidden(value) { hidden = value; for (const observer of observers) observer(); },
    observers,
    set innerHTML(_value) { throw new Error('必须使用文本节点渲染目录'); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
    replaceChildren(...children) {
      if (this.contains(this.ownerDocument?.activeElement)) this.ownerDocument.activeElement = null;
      this.children = [];
      this.append(...children.flatMap((node) => node.tag === '#fragment' ? node.children : [node]));
    },
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    listenerCount() { return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0); },
    fire(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener({ target: this, ...event }); },
    focus(options) { this.focused = options; if (this.ownerDocument) this.ownerDocument.activeElement = this; },
    getBoundingClientRect() { return tag === 'a' ? { top: 300, bottom: 320, height: 20 } : { top: 0, bottom: 100, height: 100 }; },
  };
}

function fixture({ fetcher = async () => response(), hidden = true, seriesId = 'sample', records = {}, currentPage } = {}) {
  const toc = element('aside');
  toc.id = 'toc';
  toc.hidden = hidden;
  toc.dataset = { seriesId, chapterKey: 'sample/v1/c2' };
  const nodes = Object.fromEntries(['filter', 'controls', 'status', 'retry', 'locate', 'list', 'progress-filter', 'progress-summary', 'progress-note'].map((name) => [name, element(name)]));
  nodes.controls.hidden = nodes.retry.hidden = true;
  nodes['progress-filter'].value = 'all';
  const toggle = element('button');
  const timers = new Map();
  let timerId = 0;
  const values = new Map(Object.entries(records).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const storage = { values, reads: [], denied: new Set(), deniedAll: false,
    getItem(key) { this.reads.push(key); if (this.deniedAll || this.denied.has(key)) throw new Error('denied'); return values.get(key) ?? null; },
    setItem() { throw new Error('目录不能修改进度'); }, removeItem() { throw new Error('目录不能删除进度'); },
  };
  const subscribers = new Set();
  let livePage = currentPage;
  const reader = currentPage === undefined ? null : { galleryReader: {
    getState: () => ({ page: livePage }),
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
  } };
  const window = Object.assign(element('window'), {
    localStorage: storage,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target, options) { assert.deepEqual(options.attributeFilter, ['hidden']); this.target = target; target.observers.add(this.callback); }
      disconnect() { this.target.observers.delete(this.callback); }
    },
  });
  toc.ownerDocument = {
    defaultView: window, activeElement: null,
    getElementById: (id) => id === 'toc-btn' ? toggle : id === 'reader' ? reader : null,
    createElement(tag) { const node = element(tag); node.ownerDocument = toc.ownerDocument; return node; },
    createDocumentFragment() { return this.createElement('#fragment'); },
  };
  for (const node of [window, toggle, ...Object.values(nodes)]) node.ownerDocument = toc.ownerDocument;
  toc.querySelector = (selector) => nodes[selector.slice('[data-toc-'.length, -1)];
  const calls = [];
  const api = mountChapterToc(toc, { fetcher: (url, options) => { calls.push({ url, ...options }); return fetcher(url, options); }, timeoutMs: 100 });
  return { toc, nodes, toggle, timers, calls, api, window, storage, subscribers,
    live(page) { livePage = page; for (const callback of subscribers) callback(); },
    links: () => nodes.list.children.map((item) => item.children[0]),
    indicators: () => nodes.list.children.map((item) => item.children[2]),
  };
}

test('打开前不请求；并发打开只加载一次，关闭期间完成后复用成功缓存', async () => {
  const pending = deferred();
  const f = fixture({ fetcher: () => pending.promise });
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.toggle.getAttribute('aria-expanded'), 'false');
  f.toc.hidden = false;
  f.toc.hidden = true;
  f.toc.hidden = false;
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/index/sample.json');
  assert.equal(f.toc.getAttribute('aria-busy'), 'true');
  assert.match(f.nodes.status.textContent, /加载中/);
  f.toc.hidden = true;
  pending.resolve(response());
  await settle();
  assert.equal(f.links().length, 3);
  assert.equal(f.nodes.list.scrollTop, 0, '隐藏面板完成加载时不滚动');
  f.toc.hidden = false;
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.toggle.getAttribute('aria-controls'), 'toc');
  assert.equal(f.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.toc.getAttribute('aria-busy'), 'false');
  assert.ok(f.nodes.list.scrollTop > 0);
  assert.equal(f.timers.size, 0);
  f.api.destroy();
});

test('模块加载前已打开目录时立即加载；标题按纯文本渲染，当前章有 aria-current', async () => {
  const f = fixture({ hidden: false });
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.links()[1].getAttribute('aria-current'), 'page');
  assert.equal(f.links()[2].textContent, '3. <img src=x onerror=alert(1)>');
  assert.equal(f.links()[2].href, '/sample/v2/c3/');
  assert.equal(f.nodes.controls.hidden, false);
  f.api.destroy();
});

test('筛选期名或章节；无匹配后定位当前章会清空筛选、恢复列表并聚焦', async () => {
  const f = fixture({ hidden: false });
  await settle();
  f.nodes.filter.value = '第二期';
  f.nodes.filter.fire('input');
  assert.deepEqual(f.links().map((link) => link.href), ['/sample/v2/c3/']);
  f.nodes.filter.value = '不存在的章节';
  f.nodes.filter.fire('input');
  assert.equal(f.links().length, 0);
  assert.match(f.nodes.status.textContent, /没有匹配/);
  f.nodes.locate.fire('click');
  assert.equal(f.nodes.filter.value, '');
  assert.equal(f.links().length, 3);
  assert.deepEqual(f.links()[1].focused, { preventScroll: true });
  assert.equal(f.calls.length, 1);
  f.nodes.filter.value = '２.';
  f.nodes.filter.fire('input');
  assert.equal(f.links()[0].href, '/sample/v1/c2/');
  f.api.destroy();
});

test('网络失败显示重试；重试完成后恢复目录且不重复请求', async () => {
  let attempt = 0;
  const f = fixture({ hidden: false, fetcher: async () => { if (++attempt === 1) throw new Error('offline'); return response(); } });
  await settle();
  assert.equal(f.nodes.retry.hidden, false);
  assert.equal(f.nodes.controls.hidden, true);
  assert.match(f.nodes.status.textContent, /加载失败/);
  f.nodes.retry.fire('click');
  f.nodes.retry.fire('click');
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.links().length, 3);
  assert.equal(f.nodes.retry.hidden, true);
  f.api.destroy();
});

test('目录下载超时取消请求；重试成功不受旧请求迟到影响', async () => {
  const pending = deferred();
  let attempt = 0;
  const f = fixture({ hidden: false, fetcher: () => ++attempt === 1 ? pending.promise : response() });
  await settle();
  [...f.timers.values()][0]();
  await settle();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.nodes.retry.hidden, false);
  f.nodes.retry.fire('click');
  await settle();
  pending.resolve(response({ id: 'other', issues: [] }));
  await settle();
  assert.equal(f.links().length, 3);
  assert.equal(f.nodes.retry.hidden, true);
  assert.equal(f.timers.size, 0);
  f.api.destroy();
});

test('HTTP 错误、无效 JSON、错误作品或缺少当前章均不能缓存为成功', async () => {
  for (const invalid of [
    { ok: false },
    { ok: true, json: async () => { throw new SyntaxError('bad json'); } },
    response({ id: 'other', issues: [] }),
    response({ id: 'sample', issues: [] }),
  ]) {
    let attempt = 0;
    const f = fixture({ hidden: false, fetcher: async () => ++attempt === 1 ? invalid : response() });
    await settle();
    assert.equal(f.nodes.retry.hidden, false);
    assert.equal(f.links().length, 0);
    f.nodes.retry.fire('click');
    await settle();
    assert.equal(f.links().length, 3);
    f.api.destroy();
  }
});

test('索引严格拒绝外部、跨作品、穿越及身份不一致的链接', async () => {
  for (const url of ['https://example.invalid/sample/v1/c1/', '//example.invalid/sample/v1/c1/', '/other/v1/c1/', '/sample/../c1/', '/sample/v1/c1/?q=x', '/sample/v1/c1/#p1']) {
    const data = index();
    data.issues[0].chapters[0].url = url;
    assert.throws(() => parseChapterIndex(data, 'sample'));
    const f = fixture({ hidden: false, fetcher: async () => response(data) });
    await settle();
    assert.equal(f.links().length, 0);
    assert.equal(f.nodes.retry.hidden, false);
    f.api.destroy();
  }
  const duplicate = index();
  duplicate.issues[0].chapters.push(duplicate.issues[0].chapters[0]);
  assert.throws(() => parseChapterIndex(duplicate, 'sample'));
  const missingId = index();
  delete missingId.issues[0].id;
  assert.throws(() => parseChapterIndex(missingId, 'sample'));
  const mismatch = index();
  mismatch.issues[0].chapters[0].key = 'sample/v1/c2';
  assert.throws(() => parseChapterIndex(mismatch, 'sample'));
});

test('无效作品标识不发起请求；销毁取消请求、定时器和监听，迟到响应不写 DOM', async () => {
  const invalid = fixture({ hidden: false, seriesId: '../other' });
  await settle();
  assert.equal(invalid.calls.length, 0);
  assert.equal(invalid.nodes.retry.hidden, false);
  invalid.api.destroy();
  const pending = deferred();
  const f = fixture({ hidden: false, fetcher: () => pending.promise });
  await settle();
  f.api.destroy();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.toc.observers.size, 0);
  assert.equal(f.timers.size, 0);
  for (const node of [f.nodes.filter, f.nodes.locate, f.nodes.retry]) assert.equal(node.listenerCount(), 0);
  pending.resolve(response());
  await settle();
  assert.equal(f.links().length, 0);
  f.toc.hidden = true;
  f.toc.hidden = false;
  await settle();
  assert.equal(f.calls.length, 1);
});

const progressKey = (key) => `gallery:progress:${key}`;
const savedProgress = (key, n, extra = {}) => ({ url: `/${key}/`, n, ts: 100, ...extra });

test('索引页数必须为正安全整数，目录行数有上限，合法页数进入渲染模型', () => {
  assert.deepEqual(parseChapterIndex(index(), 'sample').map((row) => row.pages), [5, 8, 4]);
  for (const pages of [undefined, 0, -1, 1.5, '5', null, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const data = index();
    data.issues[0].chapters[0].pages = pages;
    assert.throws(() => parseChapterIndex(data, 'sample'), undefined, `pages=${pages}`);
  }
  const large = index();
  large.issues = [large.issues[0]];
  large.issues[0].chapters = Array.from({ length: 20001 }, (_, i) => ({
    id: `c${i}`, key: `sample/v1/c${i}`, url: `/sample/v1/c${i}/`, title: '章节', number: i, pages: 1,
  }));
  assert.throws(() => parseChapterIndex(large, 'sample'), /章节目录格式错误/);
});

test('进度只读登记键，链接由目录构建，越界页归并到末页而不修改原记录', async () => {
  const f = fixture({ hidden: false, records: {
    [progressKey('sample/v1/c1')]: savedProgress('sample/v1/c1', 3, { title: '<script>bad()</script>' }),
    [progressKey('sample/v1/c2')]: savedProgress('sample/v1/c2', 2, { url: 'https://other.example.org/' }),
    [progressKey('sample/v2/c3')]: savedProgress('sample/v2/c3', 999),
    'another-app:secret': 'not reading data',
  } });
  const before = new Map(f.storage.values);
  await settle();
  assert.deepEqual(f.links().map((link) => link.href), ['/sample/v1/c1/#p3', '/sample/v1/c2/', '/sample/v2/c3/#p4']);
  assert.equal(f.links()[0].textContent, '1. 初遇');
  assert.match(f.indicators()[0].textContent, /读至第 3 \/ 5 页/);
  assert.equal(f.indicators()[1].textContent, '暂无进度');
  assert.match(f.indicators()[2].textContent, /已到末页 · 4 页/);
  assert.equal(f.nodes['progress-summary'].textContent, '2 话有进度 · 1 话暂无进度');
  assert.ok(f.storage.reads.every((key) => key.startsWith('gallery:progress:sample/')));
  assert.deepEqual(f.storage.values, before);
  f.api.destroy();
});

test('进度筛选与文字筛选组合使用内存缓存，定位当前章恢复全部筛选', async () => {
  const f = fixture({ hidden: false, records: {
    [progressKey('sample/v1/c1')]: savedProgress('sample/v1/c1', 2),
    [progressKey('sample/v2/c3')]: savedProgress('sample/v2/c3', 1),
  } });
  await settle();
  const reads = f.storage.reads.length;
  f.nodes['progress-filter'].value = 'started';
  f.nodes['progress-filter'].fire('change');
  assert.equal(f.links().length, 2);
  f.nodes.filter.value = '第一期';
  f.nodes.filter.fire('input');
  assert.deepEqual(f.links().map((link) => link.href), ['/sample/v1/c1/#p2']);
  f.nodes['progress-filter'].value = 'new';
  f.nodes['progress-filter'].fire('change');
  assert.deepEqual(f.links().map((link) => link.href), ['/sample/v1/c2/']);
  f.nodes.filter.value = '没有结果';
  f.nodes.filter.fire('input');
  assert.equal(f.links().length, 0);
  f.nodes.locate.fire('click');
  assert.equal(f.nodes.filter.value, '');
  assert.equal(f.nodes['progress-filter'].value, 'all');
  assert.equal(f.links().length, 3);
  assert.deepEqual(f.links()[1].focused, { preventScroll: true });
  assert.equal(f.storage.reads.length, reads, '筛选和定位不应反复扫描存储');
  f.api.destroy();
});

test('目录隐藏期间不读进度，重新打开和相关外部修改会刷新缓存但不重复取索引', async () => {
  const pending = deferred();
  const f = fixture({ fetcher: () => pending.promise });
  f.window.fire('pageshow');
  f.window.fire('storage', { key: progressKey('sample/v1/c1') });
  assert.equal(f.storage.reads.length, 0);
  f.toc.hidden = false;
  await settle();
  f.toc.hidden = true;
  pending.resolve(response());
  await settle();
  assert.equal(f.storage.reads.length, 0, '关闭期间完成索引加载也不能读取个人进度');
  f.storage.values.set(progressKey('sample/v1/c1'), JSON.stringify(savedProgress('sample/v1/c1', 2)));
  f.toc.hidden = false;
  assert.equal(f.storage.reads.length, 3);
  assert.equal(f.links()[0].href, '/sample/v1/c1/#p2');
  f.window.fire('storage', { key: 'another-app:secret' });
  f.window.fire('storage', { key: progressKey('other/v/c') });
  assert.equal(f.storage.reads.length, 3);
  f.storage.values.set(progressKey('sample/v1/c1'), JSON.stringify(savedProgress('sample/v1/c1', 4)));
  f.window.fire('storage', { key: progressKey('sample/v1/c1') });
  assert.equal(f.links()[0].href, '/sample/v1/c1/#p4');
  f.storage.values.delete(progressKey('sample/v1/c1'));
  f.window.fire('pageshow');
  assert.equal(f.links()[0].href, '/sample/v1/c1/');
  f.storage.values.set(progressKey('sample/v1/c2'), JSON.stringify(savedProgress('sample/v1/c2', 3)));
  f.window.fire('focus');
  assert.equal(f.links()[1].href, '/sample/v1/c2/#p3');
  assert.equal(f.calls.length, 1);
  f.toc.hidden = true;
  const reads = f.storage.reads.length;
  f.window.fire('storage', { key: null });
  f.window.fire('pageshow');
  assert.equal(f.storage.reads.length, reads);
  f.api.destroy();
});

test('当前章使用阅读核心实际页码，只更新当前缓存且隐藏时不读取', async () => {
  const f = fixture({ currentPage: 4, records: {
    [progressKey('sample/v1/c2')]: savedProgress('sample/v1/c2', 2),
  } });
  f.live(5);
  assert.equal(f.storage.reads.length, 0);
  f.toc.hidden = false;
  await settle();
  assert.equal(f.links()[1].href, '/sample/v1/c2/#p5');
  assert.match(f.indicators()[1].textContent, /本页进度 · 读至第 5 \/ 8 页/);
  const reads = f.storage.reads.length;
  const rendered = [...f.nodes.list.children];
  f.live(8);
  assert.equal(f.links()[1].href, '/sample/v1/c2/#p8');
  assert.match(f.indicators()[1].textContent, /本页进度 · 已到末页 · 8 页/);
  assert.equal(f.storage.reads.length, reads, '当前页变更只更新内存行，不扫描其他章节');
  assert.ok(f.nodes.list.children.every((row, index) => row === rendered[index]), '翻页应保留全部目录节点和链接焦点');
  f.toc.hidden = true;
  f.live(2);
  assert.equal(f.storage.reads.length, reads);
  f.api.destroy();
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.window.listenerCount(), 0);
});

test('读取失败不是暂无进度，当前页核心仍可用，坏值不会生成不安全页码或链接', async () => {
  const f = fixture({ hidden: false, currentPage: 2, records: {
    [progressKey('sample/v1/c1')]: '{broken',
    [progressKey('sample/v2/c3')]: savedProgress('sample/v2/c3', 0),
  } });
  f.storage.deniedAll = true;
  await settle();
  assert.equal(f.indicators()[0].textContent, '记录不可用');
  assert.equal(f.indicators()[2].textContent, '记录不可用');
  assert.match(f.indicators()[1].textContent, /本页进度/);
  assert.equal(f.nodes['progress-note'].hidden, false);
  assert.match(f.nodes['progress-summary'].textContent, /1 话有进度 · 0 话暂无进度 · 2 话记录不可用/);
  f.nodes['progress-filter'].value = 'new';
  f.nodes['progress-filter'].fire('change');
  assert.equal(f.links().length, 0);
  f.storage.deniedAll = false;
  f.window.fire('pageshow');
  assert.equal(f.links().length, 2);
  assert.equal(f.nodes['progress-note'].hidden, true);
  for (const invalid of [null, [], { url: '/sample/v1/c1/', n: '3' }, { url: '/sample/v1/c1/', n: -1 }, { url: '/sample/v1/c1/#p3', n: 3 }]) {
    f.storage.values.set(progressKey('sample/v1/c1'), JSON.stringify(invalid));
    f.window.fire('storage', { key: progressKey('sample/v1/c1') });
    assert.equal(f.links()[0].href, '/sample/v1/c1/');
    assert.equal(f.indicators()[0].textContent, '暂无进度');
  }
  Object.defineProperty(f.window, 'localStorage', { get() { throw new Error('getter denied'); } });
  f.window.fire('focus');
  assert.equal(f.links().length, 0, '属性访问也被拒绝时不会把未知项混入暂无进度');
  f.api.destroy();
});

test('外部刷新保持章节链接焦点，筛除该章后返回筛选器，未改动输入焦点', async () => {
  const f = fixture({ hidden: false, records: { [progressKey('sample/v1/c1')]: savedProgress('sample/v1/c1', 2) } });
  await settle();
  f.links()[0].focus();
  f.nodes.list.scrollTop = 45;
  f.window.fire('pageshow');
  assert.equal(f.toc.ownerDocument.activeElement, f.links()[0]);
  assert.equal(f.nodes.list.scrollTop, 45);
  f.nodes.filter.focus();
  f.window.fire('focus');
  assert.equal(f.toc.ownerDocument.activeElement, f.nodes.filter);
  f.nodes['progress-filter'].value = 'started';
  f.nodes['progress-filter'].fire('change');
  f.links()[0].focus();
  f.storage.values.delete(progressKey('sample/v1/c1'));
  f.window.fire('storage', { key: progressKey('sample/v1/c1') });
  assert.equal(f.links().length, 0);
  assert.equal(f.toc.ownerDocument.activeElement, f.nodes['progress-filter']);
  f.api.destroy();
  const reads = f.storage.reads.length;
  f.window.fire('storage', { key: null });
  f.window.fire('pageshow');
  f.window.fire('focus');
  assert.equal(f.storage.reads.length, reads);
  assert.equal(f.nodes['progress-filter'].listenerCount(), 0);
});
