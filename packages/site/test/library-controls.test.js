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
        if (selector === '[data-history-key]' && Object.hasOwn(node.dataset, 'historyKey')) return node;
      }
      return null;
    },
    querySelector(selector) {
      const row = /^\[data-series-id="([^"]+)"\] (.+)$/.exec(selector);
      if (row) return descendants(this).find((node) => node.dataset.seriesId === row[1])?.querySelector(row[2]) ?? null;
      const history = /^\[data-history-key="([^"]+)"\] (.+)$/.exec(selector);
      if (history) return descendants(this).find((node) => node.dataset.historyKey === history[1])?.querySelector(history[2]) ?? null;
      if (selector === 'a') return descendants(this).find((node) => node.tag === 'a') ?? null;
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
    listenerCount() { return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0); },
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
    data, operations, reads: 0, readKeys: [], denyReadKeys: new Set(), denyWrite: false,
    get length() { throw new Error('书架不能枚举其他应用的存储'); },
    key() { throw new Error('书架不能枚举其他应用的存储'); },
    getItem(key) {
      this.reads += 1; this.readKeys.push(key);
      if (this.denyReadKeys.has(key)) throw new Error('Storage read denied');
      return data.get(key) ?? null;
    },
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

function libraryFixture({ data = catalog(), records = {}, denied = false, deniedKeys = [] } = {}) {
  const storage = storageFixture(records);
  storage.denyReadKeys = new Set(deniedKeys);
  const win = element('window');
  const access = { denied };
  const getStorage = () => { if (access.denied) throw new Error('Storage denied'); return storage; };
  const root = element('section');
  const nodes = Object.fromEntries(['list', 'empty', 'filter', 'search', 'sort', 'count', 'storage-note', 'feedback', 'catalog', 'toolbar'].map((name) => [name, element(name)]));
  for (const [name, tag] of Object.entries({ list: 'ul', empty: 'p', search: 'input', count: 'p', more: 'button', refresh: 'button', toolbar: 'div' })) {
    nodes[`history-${name}`] = element(tag);
  }
  nodes.catalog.textContent = typeof data === 'string' ? data : JSON.stringify(data);
  nodes.filter.value = 'all';
  nodes.sort.value = 'updated';
  nodes.toolbar.hidden = nodes['history-toolbar'].hidden = nodes['history-list'].hidden = nodes['history-more'].hidden = true;
  root.querySelector = (selector) => {
    if (selector === '[data-library-toolbar]') return nodes.toolbar;
    if (selector === '[data-history-toolbar]') return nodes['history-toolbar'];
    return nodes[selector.startsWith('#library-') ? selector.slice('#library-'.length) : selector.slice(1)];
  };
  const doc = {
    defaultView: win, activeElement: null,
    createElement(tag) { const node = element(tag); node.ownerDocument = doc; return node; },
  };
  for (const node of [root, ...Object.values(nodes)]) node.ownerDocument = doc;
  const store = createLibraryStore({ getStorage, now: () => 100 });
  const controller = mountLibrary(root, { getStorage, store });
  const row = (id) => nodes.list.children.find((item) => item.dataset.seriesId === id);
  const readLink = (id) => descendants(row(id)).find((node) => node.tag === 'a' && node.className === 'btn btn-primary');
  const historyRow = (key) => nodes['history-list'].children.find((item) => item.dataset.historyKey === key);
  const historyRead = (key) => historyRow(key)?.querySelector('a');
  return { root, nodes, win, storage, store, controller, row, readLink, historyRow, historyRead, getStorage, access };
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

const reading = (key, n = 1, ts = 10) => ({ url: `/${key}/`, n, ts });
const historyKeys = (f) => f.nodes['history-list'].children.map((row) => row.dataset.historyKey);
function longHistory(count) {
  const data = [{ id: 'sample', title: '长篇故事', url: '/sample/', coverUrl: null, authors: ['作者'],
    issues: [{ id: 'v', title: '合集', chapters: Array.from({ length: count }, (_, i) => ({
      key: `sample/v/c${i + 1}`, title: `第${i + 1}章`, url: `/sample/v/c${i + 1}/`, pages: 4,
    })) }],
  }];
  const records = Object.fromEntries(Array.from({ length: count }, (_, i) => [progressKey(`sample/v/c${i + 1}`), reading(`sample/v/c${i + 1}`, 2, i + 1)]));
  return { data, records };
}

test('最近阅读逐章显示未收藏作品，只读当前目录的安全链接与元数据', () => {
  const f = libraryFixture({ records: {
    [progressKey('sample/v/c1')]: { ...reading('sample/v/c1', 99, 10), title: '存储中的伪造标题', series: '伪造作品' },
    [progressKey('sample/v/c2')]: reading('sample/v/c2', 3, 20),
    [progressKey('zeta/v/c1')]: reading('zeta/v/c1', 1, 20),
    [progressKey('sample/v/deleted')]: reading('sample/v/deleted', 1, 999),
    'another-app:secret': '不是阅读数据',
  } });
  const before = new Map(f.storage.data);
  assert.equal(f.nodes.list.children.length, 0, '阅读记录不能自动把作品加入书架');
  assert.deepEqual(historyKeys(f), ['zeta/v/c1', 'sample/v/c2', 'sample/v/c1']);
  assert.equal(f.historyRead('sample/v/c1').href, '/sample/v/c1/#p2');
  assert.equal(f.historyRead('sample/v/c2').href, '/sample/v/c2/#p3');
  assert.match(f.historyRow('sample/v/c1').textContent, /<img src=x> 示例故事/);
  assert.ok(!f.nodes['history-list'].textContent.includes('伪造'));
  assert.ok(!descendants(f.nodes['history-list']).some((node) => node.tag === 'img'), '目录标题作为文本显示');
  assert.equal(f.nodes['history-toolbar'].hidden, false);
  assert.match(f.nodes['history-count'].textContent, /3.*3/);
  assert.deepEqual(f.storage.data, before);
  assert.deepEqual(f.storage.operations, []);
  assert.deepEqual(f.storage.readKeys.filter((key) => key.startsWith('gallery:progress:')), [
    progressKey('sample/v/c1'), progressKey('sample/v/c2'), progressKey('zeta/v/c1'),
  ]);
  f.controller.destroy();
});

test('书架最近阅读排序复用共享快照，未读排后且可恢复默认顺序', () => {
  const f = libraryFixture({ records: {
    [shelfKey('sample')]: saved('want', 10), [shelfKey('zeta')]: saved('read', 20), [shelfKey('empty')]: saved('reading', 30),
    [progressKey('sample/v/c2')]: reading('sample/v/c2', 3, 50),
    [progressKey('zeta/v/c1')]: reading('zeta/v/c1', 1, 0),
  } });
  const ids = () => f.nodes.list.children.map((row) => row.dataset.seriesId);
  const reads = f.storage.reads;
  assert.deepEqual(ids(), ['empty', 'zeta', 'sample']);
  f.nodes.sort.focus();
  f.nodes.sort.value = 'recent';
  f.nodes.sort.fire('change');
  assert.deepEqual(ids(), ['sample', 'zeta', 'empty'], '有进度但无时间的作品仍排在未读作品前');
  assert.equal(f.root.ownerDocument.activeElement, f.nodes.sort);
  assert.equal(f.readLink('sample').href, '/sample/v/c2/#p3');
  f.nodes.filter.value = 'want';
  f.nodes.filter.fire('change');
  f.nodes.search.value = 'alice';
  f.nodes.search.fire('input');
  assert.deepEqual(ids(), ['sample']);
  f.nodes.search.value = '';
  f.nodes.filter.value = 'all';
  f.nodes.filter.fire('change');
  f.nodes.sort.value = 'updated';
  f.nodes.sort.fire('change');
  assert.deepEqual(ids(), ['empty', 'zeta', 'sample']);
  assert.equal(f.storage.reads, reads, '排序、搜索和状态筛选不能再次逐章读取存储');
  assert.deepEqual(f.storage.operations, []);
  f.controller.destroy();
});

test('最近阅读搜索与显示更多只用缓存，扩展列表后聚焦第一条新记录', () => {
  const f = libraryFixture(longHistory(45));
  const reads = f.storage.reads;
  assert.equal(f.nodes['history-list'].children.length, 20);
  assert.equal(historyKeys(f)[0], 'sample/v/c45');
  assert.equal(historyKeys(f).at(-1), 'sample/v/c26');
  f.nodes['history-more'].focus();
  f.nodes['history-more'].fire('click');
  assert.equal(f.nodes['history-list'].children.length, 40);
  assert.equal(f.root.ownerDocument.activeElement, f.historyRead('sample/v/c25'));
  f.nodes['history-more'].fire('click');
  assert.equal(f.nodes['history-list'].children.length, 45);
  assert.equal(f.nodes['history-more'].hidden, true);
  assert.equal(f.root.ownerDocument.activeElement, f.historyRead('sample/v/c5'));
  f.nodes['history-search'].value = '第1章';
  f.nodes['history-search'].fire('input');
  assert.deepEqual(historyKeys(f), ['sample/v/c1']);
  f.nodes['history-search'].value = '合集';
  f.nodes['history-search'].fire('input');
  assert.equal(f.nodes['history-list'].children.length, 20, '新搜索从初始显示数量开始');
  assert.equal(f.nodes['history-more'].hidden, false);
  f.nodes['history-search'].value = '没有这部作品';
  f.nodes['history-search'].fire('input');
  assert.equal(f.nodes['history-list'].hidden, true);
  assert.match(f.nodes['history-empty'].textContent, /没有匹配/);
  assert.equal(f.storage.reads, reads);
  assert.deepEqual(f.storage.operations, []);
  f.controller.destroy();
  const names = libraryFixture({ records: {
    [progressKey('sample/v/c1')]: reading('sample/v/c1'), [progressKey('zeta/v/c1')]: reading('zeta/v/c1'),
  } });
  for (const [query, key] of [['alice', 'sample/v/c1'], ['短篇集', 'zeta/v/c1'], ['开端', 'sample/v/c1']]) {
    names.nodes['history-search'].value = query;
    names.nodes['history-search'].fire('input');
    assert.deepEqual(historyKeys(names), [key], '搜索支持作者规范化、期名与章节名');
  }
  names.controller.destroy();
});

test('外部进度刷新保留章节焦点，排序移出初始范围时展开，记录移除则返回搜索', () => {
  const f = libraryFixture(longHistory(45));
  f.win.innerHeight = 200;
  f.historyRead('sample/v/c45').getBoundingClientRect = () => ({ top: 10, bottom: 30, height: 20 });
  f.historyRead('sample/v/c45').focus();
  const reads = f.storage.reads;
  f.storage.data.set(progressKey('sample/v/c45'), JSON.stringify(reading('sample/v/c45', 3, 0)));
  f.win.fire('storage', { key: progressKey('sample/v/c45') });
  assert.equal(f.nodes['history-list'].children.length, 45);
  assert.equal(f.root.ownerDocument.activeElement, f.historyRead('sample/v/c45'));
  assert.deepEqual(f.historyRead('sample/v/c45').focusOptions, { preventScroll: false }, '原焦点可见时，允许浏览器滚动到刷新后的位置');
  assert.equal(f.historyRead('sample/v/c45').href, '/sample/v/c45/#p3');
  assert.equal(f.storage.reads - reads, 46, '每次共享刷新只读45个进度和一个作品状态');
  f.historyRead('sample/v/c45').getBoundingClientRect = () => ({ top: 500, bottom: 520, height: 20 });
  f.win.fire('pageshow');
  assert.deepEqual(f.historyRead('sample/v/c45').focusOptions, { preventScroll: true }, '原焦点已离屏时不把用户滚回旧记录');
  f.win.innerHeight = 600;
  f.historyRead('sample/v/c45').getBoundingClientRect = () => {
    const top = f.nodes.list.children.length ? 1000 : 100;
    return { top, bottom: top + 20, height: 20 };
  };
  f.storage.data.set(shelfKey('sample'), JSON.stringify(saved()));
  f.win.fire('storage', { key: shelfKey('sample') });
  assert.equal(f.nodes.list.children.length, 1);
  assert.deepEqual(f.historyRead('sample/v/c45').focusOptions, { preventScroll: false }, '必须在书架卡片改变布局前记录历史焦点是否可见');
  f.storage.data.delete(progressKey('sample/v/c45'));
  f.win.fire('pageshow');
  assert.equal(f.root.ownerDocument.activeElement, f.nodes['history-search']);
  f.nodes.search.focus();
  f.win.fire('focus');
  assert.equal(f.root.ownerDocument.activeElement, f.nodes.search, '刷新不抢夺另一处输入框焦点');
  f.controller.destroy();
  const shrinking = libraryFixture(longHistory(45));
  shrinking.nodes['history-more'].focus();
  for (let i = 11; i <= 45; i++) shrinking.storage.data.delete(progressKey(`sample/v/c${i}`));
  shrinking.win.fire('storage', { key: null });
  assert.equal(shrinking.nodes['history-more'].hidden, true);
  assert.equal(shrinking.root.ownerDocument.activeElement, shrinking.nodes['history-search']);
  shrinking.controller.destroy();
});

test('最近阅读区分读取受限与坏记录，刷新可恢复，异常日期不会导致渲染失败', () => {
  const key = progressKey('sample/v/c1');
  const f = libraryFixture({ records: { [key]: reading('sample/v/c1', 2) }, deniedKeys: [key] });
  assert.equal(f.nodes['history-list'].children.length, 0);
  assert.equal(f.nodes['storage-note'].hidden, false);
  assert.match(f.nodes['history-empty'].textContent, /无法.*读取/);
  f.storage.denyReadKeys.clear();
  f.nodes['history-refresh'].fire('click');
  assert.deepEqual(historyKeys(f), ['sample/v/c1']);
  assert.equal(f.nodes['storage-note'].hidden, true);
  assert.deepEqual(f.storage.operations, []);
  f.controller.destroy();
  const bad = libraryFixture({ records: {
    [key]: '{broken',
    [progressKey('sample/v/c2')]: { url: 'javascript:alert(1)', n: 2, ts: 999 },
    [progressKey('zeta/v/c1')]: { url: '/zeta/v/c1/#p1', n: 1, ts: 999 },
  } });
  assert.equal(bad.nodes['history-list'].children.length, 0);
  assert.equal(bad.nodes['storage-note'].hidden, true, '坏内容不应伪报为存储权限错误');
  assert.match(bad.nodes['history-empty'].textContent, /还没有可用/);
  bad.controller.destroy();
  const invalidTime = libraryFixture({ records: { [key]: reading('sample/v/c1', 2, 1e17) } });
  assert.match(invalidTime.historyRow('sample/v/c1').textContent, /时间未记录/);
  const time = descendants(invalidTime.historyRow('sample/v/c1')).find((node) => node.tag === 'time');
  assert.equal(time.getAttribute('datetime'), null);
  invalidTime.controller.destroy();
  const denied = libraryFixture({ denied: true });
  assert.match(denied.nodes['history-empty'].textContent, /无法.*读取/);
  denied.controller.destroy();
});

test('共享刷新响应相关事件与按钮，销毁及备份恢复重挂载不重复监听或写入进度', () => {
  const key = progressKey('sample/v/c1');
  const f = libraryFixture({ records: { [key]: reading('sample/v/c1', 1), [shelfKey('sample')]: saved() } });
  const reads = f.storage.reads;
  f.win.fire('storage', { key: 'other-app:setting' });
  assert.equal(f.storage.reads, reads);
  f.storage.data.set(key, JSON.stringify(reading('sample/v/c1', 2, 30)));
  f.win.fire('focus');
  assert.equal(f.historyRead('sample/v/c1').href, '/sample/v/c1/#p2');
  assert.equal(f.readLink('sample').href, '/sample/v/c1/#p2');
  f.controller.destroy();
  const destroyedReads = f.storage.reads;
  for (const name of ['sort', 'history-search', 'history-more', 'history-refresh']) {
    assert.equal(f.nodes[name].listenerCount(), 0);
    f.nodes[name].fire(name === 'sort' ? 'change' : name === 'history-search' ? 'input' : 'click');
  }
  for (const type of ['storage', 'pageshow', 'focus']) f.win.fire(type, { key: null });
  assert.equal(f.win.listenerCount(), 0);
  assert.equal(f.storage.reads, destroyedReads);
  // 备份导入完成后，页面入口会销毁旧视图并重新挂载，重新读取已经恢复的记录。
  f.storage.data.set(key, JSON.stringify(reading('sample/v/c1', 1, 50)));
  const mounted = mountLibrary(f.root, { getStorage: f.getStorage, store: f.store });
  assert.equal(f.historyRead('sample/v/c1').href, '/sample/v/c1/#p1');
  assert.equal(f.readLink('sample').href, '/sample/v/c1/#p1');
  assert.equal(f.nodes['history-refresh'].listenerCount(), 1);
  assert.equal(f.win.listenerCount(), 3);
  assert.deepEqual(f.storage.operations, []);
  f.storage.denyWrite = true;
  const status = f.row('sample').querySelector('select');
  status.value = 'read'; status.fire('change');
  assert.equal(mounted.hasPending, true, '新增历史视图不应绕过备份的未保存修改检查');
  mounted.destroy();
});
