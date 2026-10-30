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

function longIndex(count) {
  return {
    id: 'sample', title: '作品', issues: [{ id: 'v1', title: '第一期', number: 1,
      chapters: Array.from({ length: count }, (_, index) => {
        const n = index + 1;
        return { id: `c${n}`, key: `sample/v1/c${n}`, url: `/sample/v1/c${n}/`, number: n, title: n % 2 ? '奇数章' : '偶数章', pages: 8 };
      }),
    }],
  };
}

// DOM 桩只提供标准契约；所有加载、校验、渲染和清理均执行生产模块。
function element(tag = '') {
  const listeners = new Map();
  const attributes = new Map();
  const observers = new Set();
  let hidden = false;
  return {
    tag, id: '', dataset: {}, children: [], value: '', textContent: '', scrollTop: 0, clientHeight: 100, disabled: false,
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
    scrollIntoView() { throw new Error('目录只能移动自己的滚动条，不能滚动漫画主体'); },
    getBoundingClientRect() { return tag === 'a' ? { top: 300, bottom: 320, height: 20 } : { top: 0, bottom: 100, height: 100 }; },
  };
}

function fixture({ fetcher = async () => response(), hidden = true, seriesId = 'sample', chapterKey = 'sample/v1/c2', records = {}, currentPage } = {}) {
  const toc = element('aside');
  toc.id = 'toc';
  toc.hidden = hidden;
  toc.dataset = { seriesId, chapterKey };
  const nodes = Object.fromEntries(['filter', 'controls', 'status', 'retry', 'locate', 'list', 'progress-filter', 'progress-summary', 'progress-note', 'pagination', 'page-prev', 'page-next', 'page-status'].map((name) => [name, element(name)]));
  nodes.controls.hidden = nodes.retry.hidden = nodes.pagination.hidden = true;
  nodes.pagination.append(nodes['page-prev'], nodes['page-status'], nodes['page-next']);
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
  for (const node of [f.nodes.filter, f.nodes.locate, f.nodes.retry, f.nodes['page-prev'], f.nodes['page-next']]) assert.equal(node.listenerCount(), 0);
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

test('两万话目录只渲染当前组的一百话，换组复用索引与进度缓存', async () => {
  const f = fixture({ hidden: false, chapterKey: 'sample/v1/c10001', currentPage: 2,
    fetcher: async () => response(longIndex(20000)),
  });
  await settle();
  assert.equal(f.links().length, 100);
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c10001');
  assert.equal(f.links().at(-1).dataset.tocChapterKey, 'sample/v1/c10100');
  assert.equal(f.links()[0].getAttribute('aria-current'), 'page');
  assert.match(f.nodes['page-status'].textContent, /101\s*\/\s*200/);
  assert.match(f.nodes.status.textContent, /10001.*10100.*20000/);
  assert.equal(f.nodes.pagination.hidden, false);
  const reads = f.storage.reads.length;
  const rendered = [...f.nodes.list.children];
  f.live(5);
  assert.equal(f.links()[0].href, '/sample/v1/c10001/#p5');
  assert.ok(f.nodes.list.children.every((row, index) => row === rendered[index]), '当前页变化不重建分组');
  f.nodes.list.scrollTop = 500;
  f.nodes['page-prev'].fire('click');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c9901');
  assert.equal(f.links().length, 100);
  assert.equal(f.nodes.list.scrollTop, 0);
  f.live(6);
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c9901', '当前章不在本组时也不跳组');
  f.nodes['page-next'].fire('click');
  assert.equal(f.links()[0].href, '/sample/v1/c10001/#p6');
  assert.equal(f.calls.length, 1);
  assert.equal(f.storage.reads.length, reads, '换组和当前页更新只使用内存缓存');
  f.api.destroy();
});

test('分组首尾按钮禁用且不越界，按钮到达边界时焦点移到可用按钮', async () => {
  const f = fixture({ hidden: false, chapterKey: 'sample/v1/c1', fetcher: async () => response(longIndex(201)) });
  await settle();
  assert.equal(f.nodes['page-prev'].disabled, true);
  assert.equal(f.nodes['page-next'].disabled, false);
  f.nodes['page-prev'].fire('click');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c1');
  f.nodes['page-next'].focus();
  f.nodes['page-next'].fire('click');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c101');
  assert.equal(f.toc.ownerDocument.activeElement, f.nodes['page-next']);
  f.nodes['page-next'].fire('click');
  assert.equal(f.links().length, 1);
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c201');
  assert.equal(f.nodes['page-next'].disabled, true);
  assert.equal(f.toc.ownerDocument.activeElement, f.nodes['page-prev']);
  f.nodes['page-next'].fire('click');
  assert.equal(f.links().length, 1, '程序化点击禁用按钮也不能越过末组');
  f.nodes['page-prev'].fire('click');
  f.nodes['page-prev'].fire('click');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c1');
  assert.equal(f.nodes['page-prev'].disabled, true);
  assert.equal(f.toc.ownerDocument.activeElement, f.nodes['page-next']);
  assert.equal(f.nodes.list.scrollTop, 0);
  f.api.destroy();
});

test('不超过一百话时不显示分组控件，超过后才显示', async () => {
  for (const count of [1, 100, 101]) {
    const f = fixture({ hidden: false, chapterKey: 'sample/v1/c1', fetcher: async () => response(longIndex(count)) });
    await settle();
    assert.equal(f.links().length, Math.min(100, count));
    assert.equal(f.nodes.pagination.hidden, count <= 100);
    f.api.destroy();
  }
});

test('文字与进度筛选重置首组并组合过滤，定位当前章清空筛选并选回其组', async () => {
  const records = Object.fromEntries(Array.from({ length: 220 }, (_, index) => {
    const key = `sample/v1/c${index + 1}`;
    return [progressKey(key), savedProgress(key, 3)];
  }));
  const f = fixture({ hidden: false, chapterKey: 'sample/v1/c201', records, fetcher: async () => response(longIndex(250)) });
  await settle();
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c201');
  const reads = f.storage.reads.length;
  f.nodes.filter.value = '章';
  f.nodes.filter.fire('input');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c1');
  f.nodes['page-next'].fire('click');
  f.nodes['progress-filter'].value = 'started';
  f.nodes['progress-filter'].fire('change');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c1');
  assert.match(f.nodes['page-status'].textContent, /1\s*\/\s*3/);
  f.nodes['page-next'].fire('click');
  f.nodes.filter.value = '偶数章';
  f.nodes.filter.fire('input');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c2');
  assert.equal(f.links().at(-1).dataset.tocChapterKey, 'sample/v1/c200');
  assert.match(f.nodes['page-status'].textContent, /1\s*\/\s*2/);
  f.nodes['progress-filter'].value = 'new';
  f.nodes['progress-filter'].fire('change');
  assert.equal(f.links().length, 15);
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c222');
  assert.equal(f.nodes.pagination.hidden, true);
  f.nodes.locate.focus();
  f.nodes.locate.fire('click');
  assert.equal(f.nodes.filter.value, '');
  assert.equal(f.nodes['progress-filter'].value, 'all');
  assert.match(f.nodes['page-status'].textContent, /3\s*\/\s*3/);
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c201');
  assert.equal(f.links().length, 50);
  assert.equal(f.toc.ownerDocument.activeElement, f.links()[0]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.storage.reads.length, reads);
  f.api.destroy();
});

test('外部进度刷新保留组序，筛选结果缩小时夹紧组序并恢复隐藏按钮焦点', async () => {
  const records = Object.fromEntries(Array.from({ length: 220 }, (_, index) => {
    const key = `sample/v1/c${index + 1}`;
    return [progressKey(key), savedProgress(key, 1)];
  }));
  const f = fixture({ hidden: false, chapterKey: 'sample/v1/c1', records, fetcher: async () => response(longIndex(250)) });
  await settle();
  f.nodes['progress-filter'].value = 'started';
  f.nodes['progress-filter'].fire('change');
  f.nodes['page-next'].fire('click');
  f.nodes['page-next'].fire('click');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c201');
  f.nodes['page-prev'].focus();
  f.storage.values.set(progressKey('sample/v1/c250'), JSON.stringify(savedProgress('sample/v1/c250', 2)));
  f.window.fire('storage', { key: progressKey('sample/v1/c250') });
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c201');
  assert.equal(f.links().length, 21);
  assert.equal(f.toc.ownerDocument.activeElement, f.nodes['page-prev']);
  for (let n = 101; n <= 250; n++) f.storage.values.delete(progressKey(`sample/v1/c${n}`));
  f.window.fire('storage', { key: null });
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c1');
  assert.equal(f.links().length, 100);
  assert.equal(f.nodes.pagination.hidden, true);
  assert.equal(f.toc.ownerDocument.activeElement, f.nodes.filter);
  f.api.destroy();
});

test('仍匹配的焦点章节因前序记录变化而跨组时跟随焦点，不匹配时返回筛选', async () => {
  const records = Object.fromEntries(Array.from({ length: 250 }, (_, index) => {
    const key = `sample/v1/c${index + 1}`;
    return [progressKey(key), savedProgress(key, 2)];
  }));
  const f = fixture({ hidden: false, chapterKey: 'sample/v1/c1', records, fetcher: async () => response(longIndex(250)) });
  await settle();
  f.nodes['progress-filter'].value = 'started';
  f.nodes['progress-filter'].fire('change');
  f.nodes['page-next'].fire('click');
  f.links()[0].focus();
  f.nodes.list.scrollTop = 0;
  f.storage.values.delete(progressKey('sample/v1/c1'));
  f.window.fire('storage', { key: progressKey('sample/v1/c1') });
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c2');
  assert.equal(f.links().at(-1).dataset.tocChapterKey, 'sample/v1/c101');
  assert.equal(f.toc.ownerDocument.activeElement, f.links().at(-1));
  assert.ok(f.nodes.list.scrollTop > 0, '焦点章节移到另一组末尾时应在目录内滚动到可见位置');
  assert.match(f.nodes['page-status'].textContent, /1\s*\/\s*3/);
  f.storage.values.delete(progressKey('sample/v1/c101'));
  f.window.fire('storage', { key: progressKey('sample/v1/c101') });
  assert.equal(f.toc.ownerDocument.activeElement, f.nodes['progress-filter']);
  f.api.destroy();
});

test('矮屏定位使用目录外框和列表的可见交集，只滚动列表', async () => {
  const f = fixture({ hidden: false, chapterKey: 'sample/v1/c201', fetcher: async () => response(longIndex(250)) });
  f.nodes.list.getBoundingClientRect = () => ({ top: 60, bottom: 260, height: 200 });
  f.toc.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 });
  await settle();
  assert.equal(f.nodes.list.scrollTop, 230, '目标应居中于实际可见的 40px，而非完整列表高度');
  assert.equal(f.toc.scrollTop, 0, '不移动目录外框或漫画页面');
  f.api.destroy();
});

test('列表滚到首尾仍被裁切时，仅由目录外框补足定位距离', async () => {
  const f = fixture({ hidden: false, chapterKey: 'sample/v1/c201', fetcher: async () => response(longIndex(250)) });
  f.nodes.list.getBoundingClientRect = () => ({ top: 60, bottom: 260, height: 200 });
  f.toc.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 });
  let scroll = 0;
  Object.defineProperty(f.nodes.list, 'scrollTop', { get: () => scroll, set: (value) => { scroll = Math.max(0, Math.min(value, 200)); } });
  await settle();
  assert.equal(f.nodes.list.scrollTop, 200);
  assert.equal(f.toc.scrollTop, 30, '列表无法完成的 30px 由目录外框承担');
  f.api.destroy();
});

test('隐藏面板不响应分组操作，重新打开定位当前组，销毁后分组按钮无监听', async () => {
  const f = fixture({ chapterKey: 'sample/v1/c201', fetcher: async () => response(longIndex(250)) });
  f.nodes['page-next'].fire('click');
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.storage.reads.length, 0);
  f.toc.hidden = false;
  await settle();
  f.nodes['page-prev'].fire('click');
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c101');
  f.toc.hidden = true;
  const reads = f.storage.reads.length;
  const links = f.links();
  f.nodes['page-prev'].fire('click');
  f.nodes['page-next'].fire('click');
  assert.equal(f.links()[0], links[0]);
  assert.equal(f.storage.reads.length, reads);
  f.toc.hidden = false;
  assert.equal(f.links()[0].dataset.tocChapterKey, 'sample/v1/c201');
  assert.equal(f.calls.length, 1);
  f.api.destroy();
  for (const name of ['page-prev', 'page-next']) assert.equal(f.nodes[name].listenerCount(), 0);
  const after = f.links();
  f.nodes['page-prev'].fire('click');
  assert.equal(f.links()[0], after[0]);
});
