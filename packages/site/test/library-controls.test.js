import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountLibrary, mountSeriesLibrary } from '../src/lib/library-controls.js';
import { createLibraryStore, LIBRARY_PREFIX } from '../src/lib/library.js';

// 只模拟本功能使用的 DOM 标准接口，交互与存储逻辑执行实际模块。
function element(tag = '') {
  const listeners = new Map();
  const attributes = new Map();
  let text = '';
  return {
    tag, tagName: tag.toUpperCase(), children: [], dataset: {}, hidden: false, value: '', parentElement: null,
    get textContent() { return text + this.children.map((child) => child.textContent).join(''); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { throw new Error('书架应以文本节点渲染目录与反馈'); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    append(...children) {
      for (const child of children) { child.parentElement = this; this.children.push(child); }
    },
    replaceChildren(...children) {
      if (this.contains(this.ownerDocument?.activeElement)) this.ownerDocument.activeElement = null;
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this.append(...children);
    },
    contains(node) { return node === this || descendants(this).includes(node); },
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === '[data-series-id]' && Object.hasOwn(node.dataset, 'seriesId')) return node;
      }
      return null;
    },
    querySelector(selector) {
      const row = /^\[data-series-id="([^"]+)"\] (.+)$/.exec(selector);
      if (row) return descendants(this).find((node) => node.dataset.seriesId === row[1])?.querySelector(row[2]) ?? null;
      if (selector === 'select') return descendants(this).find((node) => node.tag === 'select') ?? null;
      const action = /^\[data-library-action="([^"]+)"\]$/.exec(selector);
      if (action) return descendants(this).find((node) => node.dataset.libraryAction === action[1]) ?? null;
      return null;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    fire(type, event = {}) { for (const listener of listeners.get(type) ?? []) listener({ target: this, ...event }); },
    focus(options) {
      this.focused = true;
      this.focusOptions = options;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
  };
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function storageFixture(records = {}) {
  const data = new Map(Object.entries(records).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const operations = [];
  return {
    data, operations, reads: 0, denyWrite: false,
    getItem(key) { this.reads += 1; return data.get(key) ?? null; },
    setItem(key, value) {
      if (this.denyWrite) throw new Error('Storage quota exceeded');
      operations.push(['set', key]); data.set(key, value);
    },
    removeItem(key) {
      if (this.denyWrite) throw new Error('Storage remove denied');
      operations.push(['remove', key]); data.delete(key);
    },
  };
}

const saved = (status = 'want', updatedAt = 10) => ({ version: 1, status, updatedAt });
const shelfKey = (id) => LIBRARY_PREFIX + id;
const progressKey = (id) => `gallery:progress:${id}`;

function seriesFixture({ records = {}, denied = false } = {}) {
  const storage = storageFixture(records);
  const win = element('window');
  Object.defineProperty(win, 'localStorage', { get() { if (denied) throw new Error('Storage denied'); return storage; } });
  const root = element('div');
  root.hidden = true;
  root.dataset.seriesId = 'sample';
  const nodes = Object.fromEntries(['add', 'status', 'remove', 'message'].map((name) => [name, element(name)]));
  nodes.status.parentElement = element('label');
  root.querySelector = (selector) => nodes[selector.slice('[data-library-'.length, -1)];
  const doc = { defaultView: win, activeElement: null };
  for (const node of [root, ...Object.values(nodes), nodes.status.parentElement]) node.ownerDocument = doc;
  const store = createLibraryStore({ getStorage: () => win.localStorage, now: () => 20 });
  const controller = mountSeriesLibrary(root, { store });
  return { root, nodes, win, storage, store, controller };
}

function catalog() {
  return [
    {
      id: 'sample', title: '<img src=x> 示例故事', url: '/sample/', coverUrl: null, authors: ['Ａｌｉｃｅ'],
      issues: [{ id: 'v', title: '第一卷', chapters: [
        { key: 'sample/v/c1', title: '开端', url: '/sample/v/c1/', pages: 2 },
        { key: 'sample/v/c2', title: '归途', url: '/sample/v/c2/', pages: 4 },
      ] }],
    },
    {
      id: 'zeta', title: '终章', url: '/zeta/', coverUrl: null, authors: [],
      issues: [{ id: 'v', title: '短篇集', chapters: [{ key: 'zeta/v/c1', title: '终章短篇', url: '/zeta/v/c1/', pages: 1 }] }],
    },
    { id: 'empty', title: '新故事', url: '/empty/', coverUrl: null, authors: [], issues: [] },
  ];
}

function libraryFixture({ data = catalog(), records = {}, denied = false } = {}) {
  const storage = storageFixture(records);
  const win = element('window');
  const getStorage = () => { if (denied) throw new Error('Storage denied'); return storage; };
  const root = element('section');
  const nodes = Object.fromEntries(['list', 'empty', 'filter', 'search', 'count', 'storage-note', 'feedback', 'catalog', 'toolbar'].map((name) => [name, element(name)]));
  nodes.catalog.textContent = typeof data === 'string' ? data : JSON.stringify(data);
  nodes.filter.value = 'all';
  nodes.toolbar.hidden = true;
  root.querySelector = (selector) => nodes[selector === '[data-library-toolbar]' ? 'toolbar' : selector.slice('#library-'.length)];
  const doc = {
    defaultView: win, activeElement: null,
    createElement(tag) { const node = element(tag); node.ownerDocument = doc; return node; },
  };
  for (const node of [root, ...Object.values(nodes)]) node.ownerDocument = doc;
  const store = createLibraryStore({ getStorage, now: () => 100 });
  const controller = mountLibrary(root, { getStorage, store });
  const row = (id) => nodes.list.children.find((item) => item.dataset.seriesId === id);
  const readLink = (id) => descendants(row(id)).find((node) => node.tag === 'a' && node.className === 'btn btn-primary');
  return { root, nodes, win, storage, store, controller, row, readLink };
}

test('作品页书架：仅用户操作写状态，移出仍保留进度，销毁后不再处理交互', () => {
  const progress = progressKey('sample/v/c1');
  const f = seriesFixture({ records: { [progress]: { url: '/sample/v/c1/', n: 2, ts: 5 } } });
  const original = f.storage.data.get(progress);
  assert.equal(f.root.hidden, false);
  assert.equal(f.nodes.add.hidden, false);
  assert.equal(f.nodes.status.parentElement.hidden, true);
  assert.deepEqual(f.storage.operations, []);
  f.nodes.add.fire('click');
  assert.equal(f.store.read('sample').status, 'want');
  assert.equal(f.nodes.status.value, 'want');
  assert.equal(f.nodes.status.focused, true);
  f.nodes.status.value = 'read';
  f.nodes.status.fire('change');
  assert.equal(f.store.read('sample').status, 'read');
  f.nodes.remove.fire('click');
  assert.equal(f.store.read('sample'), null);
  assert.equal(f.nodes.add.hidden, false);
  assert.equal(f.nodes.add.focused, true);
  assert.equal(f.storage.data.get(progress), original);
  assert.match(f.nodes.message.textContent, /进度仍会保留/);
  f.controller.destroy();
  const operations = [...f.storage.operations];
  f.nodes.add.fire('click');
  f.nodes.status.fire('change');
  f.nodes.remove.fire('click');
  assert.deepEqual(f.storage.operations, operations);
});

test('作品页书架：存储受限时保留本页状态并明确反馈，跨标签与返回页面时刷新', () => {
  const f = seriesFixture();
  f.storage.denyWrite = true;
  f.nodes.add.fire('click');
  assert.equal(f.nodes.add.hidden, true);
  assert.equal(f.nodes.status.value, 'want');
  assert.match(f.nodes.message.textContent, /本页操作仅临时保留/);
  assert.equal(f.storage.data.has(shelfKey('sample')), false);
  f.nodes.remove.fire('click');
  assert.equal(f.nodes.add.hidden, false);
  const denied = seriesFixture({ denied: true });
  assert.equal(denied.root.hidden, false);
  assert.match(denied.nodes.message.textContent, /浏览器未允许保存/);
  denied.nodes.add.fire('click');
  assert.equal(denied.nodes.status.value, 'want');

  const synced = seriesFixture();
  synced.storage.data.set(shelfKey('sample'), JSON.stringify(saved('reading')));
  const reads = synced.storage.reads;
  synced.win.fire('storage', { key: 'unrelated' });
  assert.equal(synced.storage.reads, reads);
  synced.win.fire('storage', { key: shelfKey('sample') });
  assert.equal(synced.nodes.status.value, 'reading');
  synced.storage.data.delete(shelfKey('sample'));
  synced.win.fire('storage', { key: null });
  assert.equal(synced.nodes.add.hidden, false);
  synced.storage.data.set(shelfKey('sample'), JSON.stringify(saved('read')));
  synced.win.fire('pageshow');
  assert.equal(synced.nodes.status.value, 'read');
  for (const item of [f, denied, synced]) item.controller.destroy();
});

test('作品页跨标签收藏变化把焦点移到仍可见控件，不抢夺其他位置的焦点', () => {
  const f = seriesFixture();
  const doc = f.root.ownerDocument;
  for (const control of [f.nodes.status, f.nodes.remove]) {
    f.storage.data.set(shelfKey('sample'), JSON.stringify(saved('reading')));
    f.win.fire('pageshow');
    control.focus();
    f.storage.data.delete(shelfKey('sample'));
    f.win.fire('storage', { key: shelfKey('sample') });
    assert.equal(doc.activeElement, f.nodes.add);
    assert.equal(f.nodes.add.hidden, false);
    assert.deepEqual(f.nodes.add.focusOptions, { preventScroll: true });
  }
  f.nodes.add.focus();
  f.storage.data.set(shelfKey('sample'), JSON.stringify(saved('read')));
  f.win.fire('storage', { key: shelfKey('sample') });
  assert.equal(doc.activeElement, f.nodes.status);
  assert.equal(f.nodes.status.parentElement.hidden, false);
  assert.deepEqual(f.nodes.status.focusOptions, { preventScroll: true });

  const outside = element('input');
  outside.ownerDocument = doc;
  outside.focus();
  f.storage.data.delete(shelfKey('sample'));
  f.win.fire('storage', { key: shelfKey('sample') });
  assert.equal(doc.activeElement, outside);
  f.storage.data.set(shelfKey('sample'), JSON.stringify(saved()));
  f.win.fire('pageshow');
  assert.equal(doc.activeElement, outside);
  f.controller.destroy();
});

test('书架只显示当前作品，标题与恢复链接采用目录，搜索筛选复用内存结果', () => {
  const f = libraryFixture({ records: {
    [shelfKey('sample')]: saved('want', 10), [shelfKey('zeta')]: saved('read', 20),
    [shelfKey('empty')]: saved('reading', 30), [shelfKey('removed')]: saved('read', 999),
    [progressKey('sample/v/c1')]: { url: 'javascript:alert(1)', title: '不可信标题', n: 1, ts: 999 },
    [progressKey('sample/v/c2')]: { url: '/sample/v/c2/', title: '不可信标题', n: 99, ts: 10 },
  } });
  assert.deepEqual(f.nodes.list.children.map((item) => item.dataset.seriesId), ['empty', 'zeta', 'sample']);
  assert.equal(f.readLink('sample').href, '/sample/v/c2/#p4');
  assert.equal(f.readLink('zeta').href, '/zeta/v/c1/');
  assert.equal(f.readLink('empty'), undefined);
  assert.ok(f.row('sample').textContent.includes('<img src=x> 示例故事'));
  assert.ok(!f.row('sample').textContent.includes('不可信标题'));
  assert.equal(descendants(f.row('sample')).filter((node) => node.tag === 'img').length, 0, '标题不能作为 HTML 解析');
  assert.deepEqual(f.storage.operations, [], '打开书架不自动迁移或清理数据');
  const reads = f.storage.reads;
  f.nodes.filter.value = 'want';
  f.nodes.filter.fire('change');
  assert.deepEqual(f.nodes.list.children.map((item) => item.dataset.seriesId), ['sample']);
  f.nodes.search.value = 'alice';
  f.nodes.search.fire('input');
  assert.equal(f.nodes.list.children.length, 1, '按作者检索时处理全角字符');
  f.nodes.search.value = '没有这个故事';
  f.nodes.search.fire('input');
  assert.equal(f.nodes.list.hidden, true);
  assert.match(f.nodes.empty.textContent, /没有符合筛选条件/);
  assert.equal(f.storage.reads, reads, '搜索和状态筛选不能再次逐章读取存储');
  f.controller.destroy();
});

test('书架修改状态或移出作品后保留原阅读进度与安全继续阅读链接', () => {
  const key = progressKey('sample/v/c2');
  const f = libraryFixture({ records: { [shelfKey('sample')]: saved(), [key]: { url: '/sample/v/c2/', n: 3, ts: 10 } } });
  const original = f.storage.data.get(key);
  const status = f.row('sample').querySelector('select');
  status.value = 'read';
  status.fire('change');
  assert.equal(f.store.read('sample').status, 'read');
  assert.equal(f.readLink('sample').href, '/sample/v/c2/#p3');
  assert.equal(f.row('sample').querySelector('select').focused, true);
  assert.equal(f.storage.data.get(key), original);
  descendants(f.row('sample')).find((node) => node.tag === 'button').fire('click');
  assert.equal(f.nodes.list.children.length, 0);
  assert.equal(f.store.read('sample'), null);
  assert.equal(f.storage.data.get(key), original);
  assert.equal(f.nodes.filter.focused, true);
  assert.match(f.nodes.feedback.textContent, /阅读进度仍会保留/);
  f.controller.destroy();
});

test('书架存储失败时状态与移出操作只保留本页，正常刷新仍保留失败反馈', () => {
  const f = libraryFixture({ records: { [shelfKey('sample')]: saved() } });
  f.storage.denyWrite = true;
  const status = f.row('sample').querySelector('select');
  status.value = 'reading';
  status.fire('change');
  assert.equal(f.store.read('sample').status, 'reading');
  assert.equal(JSON.parse(f.storage.data.get(shelfKey('sample'))).status, 'want');
  assert.equal(f.nodes['storage-note'].hidden, false);
  assert.match(f.nodes['storage-note'].textContent, /本页操作仅临时保留/);
  f.win.fire('pageshow');
  assert.equal(f.row('sample').querySelector('select').value, 'reading');
  descendants(f.row('sample')).find((node) => node.tag === 'button').fire('click');
  assert.equal(f.nodes.list.children.length, 0);
  assert.equal(f.storage.data.has(shelfKey('sample')), true);
  f.controller.destroy();
  const denied = libraryFixture({ denied: true });
  assert.equal(denied.nodes.list.children.length, 0);
  assert.match(denied.nodes['storage-note'].textContent, /浏览器未允许保存/);
  denied.controller.destroy();
});

test('书架在相关 storage 与 pageshow 事件刷新，销毁后不再响应事件', () => {
  const f = libraryFixture({ records: { [shelfKey('sample')]: saved() } });
  f.storage.data.set(progressKey('sample/v/c1'), JSON.stringify({ url: '/sample/v/c1/', n: 2, ts: 5 }));
  const reads = f.storage.reads;
  f.win.fire('storage', { key: 'other-setting' });
  assert.equal(f.storage.reads, reads);
  f.win.fire('storage', { key: progressKey('sample/v/c1') });
  assert.equal(f.readLink('sample').href, '/sample/v/c1/#p2');
  f.storage.data.set(shelfKey('zeta'), JSON.stringify(saved('read', 30)));
  f.win.fire('storage', { key: shelfKey('zeta') });
  assert.equal(f.nodes.list.children.length, 2);
  f.storage.data.delete(shelfKey('sample'));
  f.win.fire('pageshow');
  assert.deepEqual(f.nodes.list.children.map((item) => item.dataset.seriesId), ['zeta']);
  f.storage.data.clear();
  f.win.fire('storage', { key: null });
  assert.equal(f.nodes.list.children.length, 0);
  f.controller.destroy();
  const after = f.storage.reads;
  f.win.fire('pageshow');
  f.win.fire('storage', { key: null });
  f.nodes.search.fire('input');
  f.nodes.filter.fire('change');
  assert.equal(f.storage.reads, after);
});

test('书架外部刷新保留当前卡片控件焦点，移除后回到筛选且不抢搜索框焦点', () => {
  const f = libraryFixture({ records: { [shelfKey('sample')]: saved(), [shelfKey('zeta')]: saved() } });
  const doc = f.root.ownerDocument;
  const previous = f.row('sample').querySelector('select');
  previous.focus();
  f.storage.data.set(shelfKey('sample'), JSON.stringify(saved('reading', 30)));
  f.win.fire('storage', { key: shelfKey('sample') });
  const current = f.row('sample').querySelector('select');
  assert.notEqual(current, previous, '刷新会重建卡片');
  assert.equal(doc.activeElement, current);
  assert.equal(current.value, 'reading');
  assert.deepEqual(current.focusOptions, { preventScroll: true });

  f.readLink('sample').focus();
  f.win.fire('pageshow');
  assert.equal(doc.activeElement, f.readLink('sample'), '操作链接也应恢复到同一张卡片');
  f.storage.data.delete(shelfKey('sample'));
  f.win.fire('storage', { key: shelfKey('sample') });
  assert.equal(doc.activeElement, f.nodes.filter);

  f.nodes.search.focus();
  f.storage.data.set(shelfKey('zeta'), JSON.stringify(saved('read', 40)));
  f.win.fire('storage', { key: shelfKey('zeta') });
  assert.equal(doc.activeElement, f.nodes.search, '刷新不能抢夺卡片之外的输入焦点');
  f.controller.destroy();
});

test('书架区分空库与未收藏，坏目录不生成可操作的错误链接', () => {
  const empty = libraryFixture({ data: [] });
  assert.match(empty.nodes.empty.textContent, /当前还没有作品/);
  assert.equal(empty.nodes.toolbar.hidden, false);
  assert.equal(empty.root.getAttribute('aria-busy'), 'false');
  empty.controller.destroy();
  const unsaved = libraryFixture();
  assert.match(unsaved.nodes.empty.textContent, /书架还是空的/);
  unsaved.controller.destroy();
  const external = catalog();
  external[0].url = 'https://example.invalid/sample/';
  const cover = catalog();
  cover[0].coverUrl = 'javascript:alert(1)';
  const mismatch = catalog();
  mismatch[0].issues[0].chapters[0].key = 'other/v/c1';
  for (const data of ['{not-json', {}, external, cover, mismatch]) {
    const invalid = libraryFixture({ data });
    assert.equal(invalid.controller, undefined);
    assert.match(invalid.nodes.empty.textContent, /目录暂时无法读取/);
    assert.equal(invalid.nodes.list.children.length, 0);
    assert.equal(invalid.nodes.toolbar.hidden, true);
    assert.equal(invalid.root.getAttribute('aria-busy'), 'false');
    assert.deepEqual(invalid.storage.operations, []);
  }
});
