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
        { id: 'c1', number: 1, title: '初遇', key: 'sample/v1/c1', url: '/sample/v1/c1/' },
        { id: 'c2', number: 2, title: '归途', key: 'sample/v1/c2', url: '/sample/v1/c2/' },
      ] },
      { id: 'v2', title: '第二期', number: 2, chapters: [
        { id: 'c3', number: 3, title: '<img src=x onerror=alert(1)>', key: 'sample/v2/c3', url: '/sample/v2/c3/' },
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
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children.flatMap((node) => node.tag === '#fragment' ? node.children : [node]); },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    listenerCount() { return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0); },
    fire(type) { for (const listener of listeners.get(type) ?? []) listener({ target: this }); },
    focus(options) { this.focused = options; },
    getBoundingClientRect() { return tag === 'a' ? { top: 300, bottom: 320, height: 20 } : { top: 0, bottom: 100, height: 100 }; },
  };
}

function fixture({ fetcher = async () => response(), hidden = true, seriesId = 'sample' } = {}) {
  const toc = element('aside');
  toc.id = 'toc';
  toc.hidden = hidden;
  toc.dataset = { seriesId, chapterKey: 'sample/v1/c2' };
  const nodes = Object.fromEntries(['filter', 'controls', 'status', 'retry', 'locate', 'list'].map((name) => [name, element(name)]));
  nodes.controls.hidden = nodes.retry.hidden = true;
  const toggle = element('button');
  const timers = new Map();
  let timerId = 0;
  const window = {
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target, options) { assert.deepEqual(options.attributeFilter, ['hidden']); this.target = target; target.observers.add(this.callback); }
      disconnect() { this.target.observers.delete(this.callback); }
    },
  };
  toc.ownerDocument = {
    defaultView: window,
    getElementById: (id) => id === 'toc-btn' ? toggle : null,
    createElement: element,
    createDocumentFragment: () => element('#fragment'),
  };
  toc.querySelector = (selector) => nodes[selector.slice('[data-toc-'.length, -1)];
  const calls = [];
  const api = mountChapterToc(toc, { fetcher: (url, options) => { calls.push({ url, ...options }); return fetcher(url, options); }, timeoutMs: 100 });
  return { toc, nodes, toggle, timers, calls, api, links: () => nodes.list.children.map((item) => item.children[0]) };
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
