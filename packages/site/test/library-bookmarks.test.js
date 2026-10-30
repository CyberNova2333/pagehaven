import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountBookmarkLibrary } from '../src/lib/library-bookmarks.js';
import { createBookmarkStore, FAVORITES_PREFIX, NOTE_PREFIX } from '../src/lib/bookmarks.js';

const key = 'sample/v/c';
const favoriteKey = FAVORITES_PREFIX + key;
const markId = (n) => `${key}/p${n}`;
const noteKey = (n) => NOTE_PREFIX + markId(n);
const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);

function element(tag = '') {
  const listeners = new Map();
  let text = '';
  return {
    tag, children: [], dataset: {}, hidden: false, value: '', parentElement: null, scrollCalls: [],
    get textContent() { return text + this.children.map((child) => child.textContent).join(''); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { throw new Error('书签正文不能作为 HTML 解析'); },
    setAttribute() {},
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
    replaceChildren(...children) {
      if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
      for (const child of this.children) child.parentElement = null;
      this.children = []; this.append(...children);
    },
    contains(node) { return node === this || descendants(this).includes(node); },
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === '[data-bookmark-id]' && node.dataset.bookmarkId) return node;
      }
      return null;
    },
    querySelectorAll(selector) { return selector === '[data-bookmark-id]' ? descendants(this).filter((node) => node.dataset.bookmarkId) : []; },
    querySelector(selector) {
      const match = /^\[data-bookmark-action="([^"]+)"\]$/.exec(selector);
      return match ? descendants(this).find((node) => node.dataset.bookmarkAction === match[1]) ?? null : null;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    fire(type, details = {}) {
      const event = { target: this, preventDefault() {}, stopPropagation() {}, ...details };
      for (const listener of [...listeners.get(type) ?? []]) listener(event);
    },
    focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; },
    scrollIntoView(options) { this.scrollCalls.push(options); },
  };
}

function catalog(pages = 6) {
  return [
    { id: 'sample', title: '示例故事', url: '/sample/', coverUrl: null, authors: [],
      issues: [{ id: 'v', title: '第一卷', chapters: [{ key, title: '开端', url: `/${key}/`, pages }] }] },
    { id: 'zeta', title: '短篇', url: '/zeta/', coverUrl: null, authors: [],
      issues: [{ id: 'v', title: '短篇集', chapters: [{ key: 'zeta/v/c', title: '终章', url: '/zeta/v/c/', pages: 2 }] }] },
  ];
}

function fixture({ records = {}, data = catalog(), denied = false, deniedKeys = [], autoFlushStorage = true, onSummary, searchValue = '', withoutSearch = false } = {}) {
  const values = new Map(Object.entries(records).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]));
  const storage = {
    values, reads: 0, writes: [], denied, denyReadKeys: new Set(deniedKeys),
    getItem(name) { this.reads++; if (this.denyReadKeys.has(name)) throw new Error('read denied'); return values.get(name) ?? null; },
    setItem(name, value) { if (this.denied) throw new Error('quota'); this.writes.push(['set', name]); values.set(name, value); },
    removeItem(name) { if (this.denied) throw new Error('denied'); this.writes.push(['remove', name]); values.delete(name); },
  };
  const root = element('section');
  const win = element('window');
  const timers = new Map();
  let timerId = 0;
  win.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  win.clearTimeout = (id) => timers.delete(id);
  win.flushTimers = () => {
    for (const [id, timer] of [...timers]) {
      if (!timers.delete(id)) continue;
      timer.callback();
    }
  };
  win.timers = timers;
  const fire = win.fire.bind(win);
  win.fire = (type, details) => { fire(type, details); if (type === 'storage' && autoFlushStorage) win.flushTimers(); };
  win.localStorage = storage;
  const names = ['list', 'empty', 'filter', 'search', 'count', 'storage-note', 'feedback', 'more', 'editor', 'editor-title', 'note', 'save', 'cancel', 'toolbar', 'catalog'];
  const nodes = Object.fromEntries(names.map((name) => [name, element(name)]));
  nodes.search.value = searchValue;
  nodes.catalog.textContent = typeof data === 'string' ? data : JSON.stringify(data);
  nodes.editor.hidden = nodes.toolbar.hidden = true;
  root.querySelector = (selector) => selector === '#bookmark-search' && withoutSearch ? null : nodes[selector === '[data-bookmark-toolbar]' ? 'toolbar'
    : selector === '#library-bookmark-note' ? 'note' : selector.slice('#bookmark-'.length)];
  const doc = { defaultView: win, activeElement: null,
    getElementById: (id) => id === 'library-catalog' ? nodes.catalog : null,
    createElement(tag) { const node = element(tag); node.ownerDocument = doc; return node; },
  };
  for (const node of [root, win, ...Object.values(nodes)]) node.ownerDocument = doc;
  const store = createBookmarkStore({ getStorage: () => storage, now: () => 30 });
  const summaries = [];
  const controller = mountBookmarkLibrary(root, { store, onSummary(summary) {
    summaries.push({ ...summary });
    onSummary?.(summary);
  } });
  const row = (id) => nodes.list.children.find((node) => node.dataset.bookmarkId === id);
  const action = (id, type) => row(id)?.querySelector(`[data-bookmark-action="${type}"]`);
  return { root, nodes, doc, win, store, storage, controller, row, action, summaries };
}

function search(f, value) {
  f.nodes.search.value = value;
  f.nodes.search.fire('input');
}

const visibleIds = (f) => f.nodes.list.children.map((node) => node.dataset.bookmarkId);

test('书架集中显示当前目录的旧页收藏，无需收藏作品，越界和旧目录只过滤不改写', () => {
  const f = fixture({ records: {
    [favoriteKey]: [markId(3), markId(1), markId(99), 'removed/v/c/p1'],
    [noteKey(3)]: { version: 1, note: '<img src=x> 备注\n下一行', updatedAt: 10 },
    [FAVORITES_PREFIX + 'zeta/v/c']: ['zeta/v/c/p2'],
    [FAVORITES_PREFIX + 'removed/v/c']: ['removed/v/c/p1'],
  } });
  assert.deepEqual(f.nodes.list.children.map((node) => node.dataset.bookmarkId), [markId(1), markId(3), 'zeta/v/c/p2']);
  assert.equal(f.action(markId(3), 'read').href, `/${key}/#p3`);
  assert.ok(f.row(markId(3)).textContent.includes('<img src=x> 备注\n下一行'));
  assert.equal(descendants(f.row(markId(3))).some((node) => node.tag === 'img'), false);
  assert.deepEqual(f.storage.writes, []);
  const reads = f.storage.reads;
  f.nodes.filter.value = 'zeta';
  f.nodes.filter.fire('change');
  assert.deepEqual(f.nodes.list.children.map((node) => node.dataset.bookmarkId), ['zeta/v/c/p2']);
  f.nodes.filter.value = 'unknown'; f.nodes.filter.fire('change');
  assert.equal(f.nodes.list.hidden, true);
  assert.match(f.nodes.empty.textContent, /还没有页码书签/);
  assert.equal(f.storage.reads, reads, '筛选不得重复扫描浏览器存储');
  f.controller.destroy();
});

test('备注保存锁定原目标页，取消和超长输入不写入，移除保留阅读进度与作品收藏', () => {
  const progress = 'gallery:progress:' + key;
  const shelf = 'gallery:library:sample';
  const f = fixture({ records: { [favoriteKey]: [markId(1), markId(2)], [progress]: { n: 5 }, [shelf]: { status: 'reading' } } });
  const original = [f.storage.values.get(progress), f.storage.values.get(shelf)];
  f.action(markId(1), 'edit').fire('click');
  assert.equal(f.nodes.editor.hidden, false);
  f.nodes.note.value = '第一页草稿';
  f.action(markId(2), 'edit').fire('click');
  assert.match(f.nodes['editor-title'].textContent, /第 1 页/);
  assert.equal(f.nodes.note.value, '第一页草稿', '点击其他书签不能丢弃正在编辑的草稿');
  f.nodes.save.fire('click');
  assert.equal(JSON.parse(f.storage.values.get(noteKey(1))).note, '第一页草稿');
  assert.equal(f.storage.values.has(noteKey(2)), false);
  assert.equal(f.doc.activeElement, f.action(markId(1), 'edit'));
  const writes = [...f.storage.writes];
  f.action(markId(2), 'edit').fire('click'); f.nodes.note.value = '不保存'; f.nodes.cancel.fire('click');
  assert.deepEqual(f.storage.writes, writes);
  f.action(markId(2), 'edit').fire('click'); f.nodes.note.value = '长'.repeat(201); f.nodes.save.fire('click');
  assert.equal(f.nodes.editor.hidden, false);
  assert.match(f.nodes.feedback.textContent, /最多 200/);
  assert.deepEqual(f.storage.writes, writes);
  f.nodes.editor.fire('keydown', { key: 'Escape' });
  assert.equal(f.nodes.editor.hidden, true);
  f.action(markId(1), 'remove').fire('click');
  assert.equal(f.row(markId(1)), undefined);
  assert.equal(f.storage.values.has(noteKey(1)), false);
  assert.deepEqual([f.storage.values.get(progress), f.storage.values.get(shelf)], original);
  assert.equal(f.doc.activeElement, f.nodes.filter);
  f.controller.destroy();
});

test('保存失败时显示本页备注和反馈，订阅更新只读刷新且不会递归写入', () => {
  const f = fixture({ records: { [favoriteKey]: [markId(1)] }, denied: true });
  f.action(markId(1), 'edit').fire('click'); f.nodes.note.value = '临时备注'; f.nodes.save.fire('click');
  assert.ok(f.row(markId(1)).textContent.includes('临时备注'));
  assert.match(f.nodes.feedback.textContent, /未能完整保存/);
  assert.equal(f.nodes['storage-note'].hidden, false);
  assert.equal(f.storage.values.has(noteKey(1)), false);
  f.store.set(key, 6, 2, '其他组件新增');
  assert.ok(f.row(markId(2)).textContent.includes('其他组件新增'));
  assert.deepEqual(f.storage.writes, []);
  f.controller.destroy();
  f.store.set(key, 6, 3, '销毁后不刷新');
  assert.equal(f.row(markId(3)), undefined);
});

test('storage 与 pageshow 刷新保留卡片焦点，编辑草稿不被外部更新覆盖', () => {
  const f = fixture({ records: { [favoriteKey]: [markId(1), markId(2)] } });
  f.action(markId(1), 'edit').focus();
  f.storage.values.set(noteKey(1), JSON.stringify({ version: 1, note: '其他标签页备注', updatedAt: 40 }));
  f.win.fire('storage', { key: noteKey(1) });
  assert.equal(f.doc.activeElement, f.action(markId(1), 'edit'));
  assert.ok(f.row(markId(1)).textContent.includes('其他标签页备注'));
  f.action(markId(1), 'read').focus(); f.win.fire('pageshow');
  assert.equal(f.doc.activeElement, f.action(markId(1), 'read'));
  f.action(markId(1), 'edit').fire('click'); f.nodes.note.value = '仍在编辑'; f.nodes.note.focus();
  f.storage.values.set(noteKey(1), JSON.stringify({ version: 1, note: '更新但不能覆盖草稿', updatedAt: 50 }));
  f.win.fire('storage', { key: noteKey(1) });
  assert.equal(f.doc.activeElement, f.nodes.note);
  assert.equal(f.nodes.note.value, '仍在编辑');
  f.nodes.cancel.fire('click'); f.action(markId(1), 'remove').focus();
  f.storage.values.set(favoriteKey, JSON.stringify([markId(2)])); f.win.fire('storage', { key: favoriteKey });
  assert.equal(f.doc.activeElement, f.nodes.filter);
  const reads = f.storage.reads;
  f.win.fire('storage', { key: 'unrelated' });
  assert.equal(f.storage.reads, reads);
  f.controller.destroy();
  f.win.fire('pageshow'); f.win.fire('storage', { key: null });
  assert.equal(f.storage.reads, reads);
});

test('书签超过 50 条按批显示，显示更多和筛选都不重复读取存储', () => {
  const f = fixture({ data: catalog(60), records: { [favoriteKey]: Array.from({ length: 55 }, (_, index) => markId(index + 1)) } });
  assert.equal(f.nodes.list.children.length, 50);
  assert.equal(f.nodes.more.hidden, false);
  assert.match(f.nodes.count.textContent, /显示 50 \/ 55/);
  const reads = f.storage.reads;
  f.nodes.more.fire('click');
  assert.equal(f.nodes.list.children.length, 55);
  assert.equal(f.nodes.more.hidden, true);
  assert.equal(f.doc.activeElement, f.nodes.filter);
  f.nodes.filter.value = 'sample'; f.nodes.filter.fire('change');
  assert.equal(f.nodes.list.children.length, 50, '切换筛选后回到首批');
  assert.equal(f.storage.reads, reads);
  f.controller.destroy();
});

test('空书签目录与坏目录提供提示，打开时不创建记录', () => {
  const f = fixture({ data: [] });
  assert.deepEqual(f.summaries, [{ bookmarks: 0, notes: 0, limited: false, pending: false }]);
  assert.equal(f.nodes.list.hidden, true);
  assert.match(f.nodes.empty.textContent, /还没有页码书签/);
  assert.equal(f.nodes.toolbar.hidden, false);
  assert.deepEqual(f.storage.writes, []);
  f.controller.destroy();
  const invalid = fixture({ data: '{bad' });
  assert.deepEqual(invalid.summaries, [], '目录不可读时不发布假零值概览');
  assert.equal(invalid.controller, undefined);
  assert.match(invalid.nodes.empty.textContent, /目录暂时无法读取/);
  assert.equal(invalid.nodes.toolbar.hidden, true);
  assert.deepEqual(invalid.storage.writes, []);
});

test('书签批量存储事件只刷新一次并读取最终备注，保留焦点及正在编辑的草稿', () => {
  const f = fixture({ autoFlushStorage: false, records: {
    [favoriteKey]: [markId(1)], [noteKey(1)]: { version: 1, note: '初始备注', updatedAt: 1 },
  } });
  const oldLink = f.action(markId(1), 'read');
  oldLink.focus();
  const reads = f.storage.reads;
  f.win.fire('storage', { key: 'another-app:setting' });
  assert.equal(f.win.timers.size, 0);
  for (let i = 0; i < 1000; i++) {
    f.storage.values.set(noteKey(1), JSON.stringify({ version: 1, note: `外部备注 ${i}`, updatedAt: i + 2 }));
    f.win.fire('storage', { key: noteKey(1) });
    if (i % 10 === 0) f.win.fire('storage', { key: favoriteKey });
  }
  assert.equal(f.storage.reads, reads);
  assert.equal(f.win.timers.size, 1);
  assert.equal(f.action(markId(1), 'read'), oldLink);
  f.win.flushTimers();
  assert.equal(f.storage.reads, reads + 3, '两个作品的收藏及一个有效备注各读取一次');
  assert.ok(f.row(markId(1)).textContent.includes('外部备注 999'));
  assert.equal(f.doc.activeElement, f.action(markId(1), 'read'));
  assert.deepEqual(f.storage.writes, []);
  f.action(markId(1), 'edit').fire('click');
  f.nodes.note.value = '本页未保存草稿';
  f.nodes.note.focus();
  f.storage.values.set(noteKey(1), JSON.stringify({ version: 1, note: '另一个标签页的备注', updatedAt: 2000 }));
  f.win.fire('storage', { key: noteKey(1) });
  f.win.flushTimers();
  assert.equal(f.nodes.note.value, '本页未保存草稿');
  assert.equal(f.doc.activeElement, f.nodes.note);
  assert.equal(f.controller.isEditing, true);
  f.controller.destroy();
});

test('书签同步恢复或显式保存取消排队刷新，销毁后旧回调不能影响重挂界面', () => {
  const f = fixture({ autoFlushStorage: false, records: { [favoriteKey]: [markId(1)] } });
  for (const type of ['pageshow', 'focus']) {
    f.win.fire('storage', { key: null });
    const staleBeforeShow = [...f.win.timers.values()][0].callback;
    f.win.fire(type);
    assert.equal(f.win.timers.size, 0);
    const afterShow = f.storage.reads;
    staleBeforeShow(); f.win.flushTimers();
    assert.equal(f.storage.reads, afterShow);
  }
  f.action(markId(1), 'edit').fire('click');
  f.nodes.note.value = '明确保存的备注';
  f.win.fire('storage', { key: favoriteKey });
  f.nodes.save.fire('click');
  assert.equal(f.win.timers.size, 0);
  assert.equal(JSON.parse(f.storage.values.get(noteKey(1))).note, '明确保存的备注');
  const afterSave = f.storage.reads;
  f.win.flushTimers();
  assert.equal(f.storage.reads, afterSave);
  f.win.fire('storage', { key: noteKey(1) });
  const stale = [...f.win.timers.values()][0].callback;
  f.controller.destroy();
  assert.equal(f.win.timers.size, 0);
  const mounted = mountBookmarkLibrary(f.root, { store: f.store });
  const remountedReads = f.storage.reads;
  stale(); f.win.flushTimers();
  assert.equal(f.storage.reads, remountedReads);
  assert.ok(f.row(markId(1)).textContent.includes('明确保存的备注'));
  mounted.destroy();
});

test('书签概览只统计当前有效收藏页及文字备注，筛选和编辑草稿不改变总量', () => {
  const zeta = 'zeta/v/c/p2';
  const f = fixture({ records: {
    [favoriteKey]: [markId(1), markId(2), markId(3), markId(4), markId(5), markId(99)],
    [FAVORITES_PREFIX + 'zeta/v/c']: [zeta],
    [FAVORITES_PREFIX + 'removed/v/c']: ['removed/v/c/p1'],
    [noteKey(1)]: { version: 1, note: '有效备注', updatedAt: 1 },
    [noteKey(2)]: { version: 1, note: ' \n ', updatedAt: 2 },
    [noteKey(3)]: { version: 1, note: '', updatedAt: 3 },
    [noteKey(4)]: '{bad',
    [noteKey(5)]: { version: 1, note: '无效时间', updatedAt: -1 },
    [noteKey(6)]: { version: 1, note: '没有收藏该页的独立备注', updatedAt: 6 },
    [NOTE_PREFIX + zeta]: { version: 1, note: '另一作品备注', updatedAt: 7 },
  } });
  const total = { bookmarks: 6, notes: 2, limited: false, pending: false };
  assert.deepEqual(f.summaries, [total]);
  assert.equal(f.storage.reads, 8, '两个收藏键与六个有效收藏页的备注各读一次，不为概览重扫');
  const reads = f.storage.reads;
  f.nodes.filter.value = 'zeta'; f.nodes.filter.fire('change');
  f.nodes.more.fire('click');
  assert.equal(f.nodes.list.children.length, 1);
  f.action(zeta, 'edit').fire('click');
  f.nodes.note.value = '尚未保存的编辑草稿';
  assert.deepEqual(f.summaries, [total]);
  assert.equal(f.storage.reads, reads);
  assert.deepEqual(f.storage.writes, []);
  f.nodes.cancel.fire('click');
  f.controller.destroy();
});

test('书签概览跟随保存和移除，并标记内存修改及部分读取结果', () => {
  const f = fixture({ records: { [favoriteKey]: [markId(1)] } });
  f.action(markId(1), 'edit').fire('click');
  f.nodes.note.value = '明确保存'; f.nodes.save.fire('click');
  assert.deepEqual(f.summaries.at(-1), { bookmarks: 1, notes: 1, limited: false, pending: false });
  f.action(markId(1), 'remove').fire('click');
  assert.deepEqual(f.summaries.at(-1), { bookmarks: 0, notes: 0, limited: false, pending: false });
  f.storage.denied = true;
  f.store.set(key, 6, 2, '未落盘备注');
  assert.equal(f.controller.hasPending, true);
  assert.equal(f.storage.values.has(noteKey(2)), false);
  assert.deepEqual(f.summaries.at(-1), { bookmarks: 1, notes: 1, limited: true, pending: true });
  f.controller.destroy();

  const zeta = 'zeta/v/c/p2';
  const partial = fixture({ records: {
    [favoriteKey]: [markId(1)], [FAVORITES_PREFIX + 'zeta/v/c']: [zeta],
    [NOTE_PREFIX + zeta]: { version: 1, note: '可读备注', updatedAt: 1 },
  }, deniedKeys: [favoriteKey] });
  assert.deepEqual(partial.summaries.at(-1), { bookmarks: 1, notes: 1, limited: true, pending: false });
  assert.deepEqual(partial.storage.writes, []);
  partial.controller.destroy();
});

test('书签概览异常不影响明确保存，旧任务销毁后不再报告并能重读恢复数据', () => {
  const f = fixture({ autoFlushStorage: false, records: { [favoriteKey]: [markId(1)] },
    onSummary() { throw new Error('概览视图失效'); },
  });
  f.action(markId(1), 'edit').fire('click');
  f.nodes.note.value = '仍可保存'; f.nodes.save.fire('click');
  assert.equal(JSON.parse(f.storage.values.get(noteKey(1))).note, '仍可保存');
  f.win.fire('storage', { key: favoriteKey });
  const stale = [...f.win.timers.values()][0].callback;
  f.controller.destroy();
  const oldReports = f.summaries.length;
  f.storage.values.set(favoriteKey, JSON.stringify([markId(2)]));
  f.storage.values.set(noteKey(2), JSON.stringify({ version: 1, note: '恢复的备注', updatedAt: 60 }));
  const restored = [];
  const mounted = mountBookmarkLibrary(f.root, { onSummary: (value) => restored.push({ ...value }) });
  assert.deepEqual(restored, [{ bookmarks: 1, notes: 1, limited: false, pending: false }]);
  stale(); f.win.flushTimers();
  assert.equal(f.summaries.length, oldReports);
  assert.equal(restored.length, 1);
  assert.equal(f.row(markId(1)), undefined);
  assert.ok(f.row(markId(2)).textContent.includes('恢复的备注'));
  mounted.destroy();
});

test('书签查找匹配备注及元数据，统一全角和大小写，并将特殊字符作为连续原文', () => {
  const data = catalog();
  data[0].title = '北极光 ＳＴＯＲＹ';
  data[0].authors = ['Ａｌｉｃｅ', '作者乙'];
  data[0].issues[0].title = '第七集';
  data[0].issues[0].chapters[0].title = '黎明之章';
  const zeta = 'zeta/v/c/p2';
  const f = fixture({ data, records: {
    [favoriteKey]: [markId(1), markId(2)],
    [noteKey(1)]: { version: 1, note: '月下约定 <img src=x> [a.*] Ｃａｆｅ\u0301', updatedAt: 1 },
    [FAVORITES_PREFIX + 'zeta/v/c']: [zeta],
  } });
  const initialReads = f.storage.reads;
  const totals = [...f.summaries];
  f.nodes.search.focus();
  for (const [query, expected] of [
    ['北极光', [markId(1), markId(2)]], ['story', [markId(1), markId(2)]],
    ['  ａｌＩｃｅ\t', [markId(1), markId(2)]], ['作者乙', [markId(1), markId(2)]],
    ['第七集', [markId(1), markId(2)]], ['黎明', [markId(1), markId(2)]],
    ['月下约', [markId(1)]], ['CAFÉ', [markId(1)]], ['[a.*]', [markId(1)]],
    ['<img src=x>', [markId(1)]], ['^$', []], ['北极光 约定', []],
    ['　 \t', [markId(1), markId(2), zeta]],
  ]) {
    search(f, query);
    assert.deepEqual(visibleIds(f), expected, `查询 ${JSON.stringify(query)} 应按连续文本匹配`);
    assert.equal(f.doc.activeElement, f.nodes.search, '重建结果不能打断搜索输入焦点');
  }
  assert.equal(descendants(f.nodes.list).some((node) => node.tag === 'img'), false);
  assert.equal(f.storage.reads, initialReads, '搜索复用已加载快照，不重读收藏或备注');
  assert.deepEqual(f.storage.writes, [], '查询不落盘，也不清理记录');
  assert.deepEqual(f.summaries, totals, '结果筛选不重新报告或改变阅读概览总量');
  f.controller.destroy();
});

test('书签查找与作品筛选组合，零匹配和全站无书签分别说明', () => {
  const zeta = 'zeta/v/c/p1';
  const f = fixture({ records: {
    [favoriteKey]: [markId(1), markId(2)],
    [noteKey(1)]: { version: 1, note: '共同约定', updatedAt: 1 },
    [FAVORITES_PREFIX + 'zeta/v/c']: [zeta],
    [NOTE_PREFIX + zeta]: { version: 1, note: '共同约定', updatedAt: 1 },
  } });
  const reads = f.storage.reads;
  search(f, '共同');
  assert.deepEqual(visibleIds(f), [markId(1), zeta]);
  f.nodes.filter.value = 'zeta'; f.nodes.filter.fire('change');
  assert.deepEqual(visibleIds(f), [zeta]);
  assert.equal(f.nodes.search.value, '共同');
  search(f, '开端');
  assert.equal(f.nodes.list.hidden, true);
  assert.equal(f.nodes.empty.hidden, false);
  assert.match(f.nodes.empty.textContent, /没有.*匹配|没有.*符合/);
  assert.match(f.nodes.count.textContent, /共 3 个书签.*显示 0 \/ 0/);
  assert.equal(f.nodes.more.hidden, true);
  f.nodes.filter.value = ''; f.nodes.filter.fire('change');
  assert.deepEqual(visibleIds(f), [markId(1), markId(2)]);
  search(f, '');
  assert.equal(f.nodes.list.children.length, 3);
  assert.equal(f.storage.reads, reads);
  assert.deepEqual(f.storage.writes, []);
  f.controller.destroy();

  const empty = fixture({ searchValue: '任意搜索' });
  assert.equal(empty.nodes.list.hidden, true);
  assert.match(empty.nodes.empty.textContent, /还没有页码书签/);
  assert.deepEqual(empty.storage.writes, []);
  empty.controller.destroy();
});

test('书签搜索结果每批最多 50 条，查询和作品变化重置首批且不重读存储', () => {
  const records = { [favoriteKey]: Array.from({ length: 120 }, (_, index) => markId(index + 1)) };
  for (let n = 1; n <= 120; n++) records[noteKey(n)] = { version: 1, note: n <= 107 ? '寻光记录' : '其他记录', updatedAt: n };
  const f = fixture({ data: catalog(120), records });
  const reads = f.storage.reads;
  const totals = [...f.summaries];
  search(f, '寻光');
  assert.equal(f.nodes.list.children.length, 50);
  assert.match(f.nodes.count.textContent, /显示 50 \/ 107/);
  f.nodes.more.fire('click');
  assert.equal(f.nodes.list.children.length, 100);
  assert.equal(f.nodes.more.hidden, false);
  f.nodes.more.fire('click');
  assert.equal(f.nodes.list.children.length, 107);
  assert.equal(f.nodes.more.hidden, true);
  search(f, '寻');
  assert.equal(f.nodes.list.children.length, 50, '修改查询不能沿用上次的展开数量');
  f.nodes.more.fire('click');
  f.nodes.filter.value = 'sample'; f.nodes.filter.fire('change');
  assert.equal(f.nodes.list.children.length, 50, '变更作品筛选也回到当前搜索的首批');
  assert.equal(f.nodes.search.value, '寻');
  search(f, '找不到');
  assert.equal(f.nodes.list.children.length, 0);
  assert.equal(f.nodes.more.hidden, true);
  search(f, '');
  assert.equal(f.nodes.list.children.length, 50);
  assert.match(f.nodes.count.textContent, /显示 50 \/ 120/);
  assert.equal(f.storage.reads, reads);
  assert.deepEqual(f.storage.writes, []);
  assert.deepEqual(f.summaries, totals);
  f.controller.destroy();
});

test('书签搜索忽略输入框草稿，外部备注重建查询缓存且保留正在编辑的目标', () => {
  const f = fixture({ autoFlushStorage: false, records: {
    [favoriteKey]: [markId(1), markId(2)],
    [noteKey(1)]: { version: 1, note: '晨光', updatedAt: 1 },
    [noteKey(2)]: { version: 1, note: '暮色', updatedAt: 1 },
  } });
  search(f, '晨光');
  f.action(markId(1), 'edit').fire('click');
  f.nodes.note.value = '输入框草稿';
  const reads = f.storage.reads;
  search(f, '输入框草稿');
  assert.equal(f.nodes.list.hidden, true, '备注草稿尚未提交，不能进入搜索快照');
  assert.equal(f.controller.isEditing, true);
  assert.equal(f.nodes.editor.hidden, false);
  assert.equal(f.nodes.note.value, '输入框草稿');
  search(f, '晨光');
  assert.deepEqual(visibleIds(f), [markId(1)]);
  assert.equal(f.storage.reads, reads);
  f.nodes.note.focus();
  f.storage.values.set(noteKey(1), JSON.stringify({ version: 1, note: '远方', updatedAt: 40 }));
  f.win.fire('storage', { key: noteKey(1) });
  assert.equal(f.win.timers.size, 1);
  assert.deepEqual(visibleIds(f), [markId(1)], '合并刷新前保留旧快照');
  f.win.flushTimers();
  assert.equal(f.nodes.search.value, '晨光');
  assert.equal(f.nodes.list.hidden, true, '刷新后必须按外部保存的新备注重新匹配');
  assert.equal(f.controller.isEditing, true);
  assert.equal(f.nodes.note.value, '输入框草稿');
  assert.equal(f.doc.activeElement, f.nodes.note);
  search(f, '远方');
  assert.deepEqual(visibleIds(f), [markId(1)]);
  f.nodes.cancel.fire('click');
  assert.equal(f.controller.isEditing, false);
  assert.equal(f.row(markId(1)).textContent.includes('输入框草稿'), false);
  assert.deepEqual(f.storage.writes, []);
  f.controller.destroy();
});

test('保存后不再匹配时关闭编辑并返回搜索，写失败仍按临时备注搜索且保留备份保护', () => {
  const f = fixture({ records: {
    [favoriteKey]: [markId(1)],
    [noteKey(1)]: { version: 1, note: '原始命中', updatedAt: 1 },
  } });
  search(f, '原始命中');
  f.action(markId(1), 'edit').fire('click');
  f.nodes.note.value = '新备注';
  f.nodes.save.fire('click');
  assert.equal(f.nodes.list.hidden, true);
  assert.equal(f.nodes.editor.hidden, true);
  assert.equal(f.controller.isEditing, false);
  assert.equal(f.doc.activeElement, f.nodes.search);
  assert.deepEqual(f.nodes.search.scrollCalls, [{ block: 'center', inline: 'nearest' }], '保存后结果消失时，搜索回退焦点必须居中可见');
  assert.equal(JSON.parse(f.storage.values.get(noteKey(1))).note, '新备注');
  search(f, '新备注');
  f.action(markId(1), 'edit').fire('click');
  f.nodes.note.value = '临时命中';
  f.storage.denied = true;
  f.nodes.save.fire('click');
  assert.equal(f.nodes.list.hidden, true);
  assert.equal(f.nodes.editor.hidden, true);
  assert.equal(f.doc.activeElement, f.nodes.search);
  assert.equal(f.nodes.search.scrollCalls.length, 2, '保存失败后的临时结果失配也需要显示回退焦点');
  assert.equal(f.controller.hasPending, true);
  assert.match(f.nodes.feedback.textContent, /未能完整保存/);
  assert.equal(JSON.parse(f.storage.values.get(noteKey(1))).note, '新备注', '写失败不能伪装成已持久保存');
  search(f, '临时命中');
  assert.deepEqual(visibleIds(f), [markId(1)]);
  assert.deepEqual(f.summaries.at(-1), { bookmarks: 1, notes: 1, limited: true, pending: true });
  f.storage.denied = false;
  f.action(markId(1), 'edit').fire('click');
  f.nodes.note.value = '重试成功'; f.nodes.save.fire('click');
  assert.equal(f.controller.hasPending, false);
  assert.equal(f.doc.activeElement, f.nodes.search);
  search(f, '重试成功');
  assert.deepEqual(visibleIds(f), [markId(1)]);
  assert.equal(JSON.parse(f.storage.values.get(noteKey(1))).note, '重试成功');
  f.controller.destroy();
});

test('明确取消编辑时显示消失目标的回退焦点，外部刷新失配只恢复焦点而不主动滚动', () => {
  const f = fixture({ records: {
    [favoriteKey]: [markId(1), markId(2)],
    [noteKey(1)]: { version: 1, note: '晨光', updatedAt: 1 },
    [noteKey(2)]: { version: 1, note: '暮色', updatedAt: 1 },
  } });
  search(f, '晨光');
  f.action(markId(1), 'edit').fire('click');
  f.nodes.cancel.fire('click');
  assert.equal(f.doc.activeElement, f.action(markId(1), 'edit'));
  assert.deepEqual(f.action(markId(1), 'edit').scrollCalls, [], '原目标仍可见时不触发回退滚动');
  assert.deepEqual(f.nodes.search.scrollCalls, []);
  f.action(markId(1), 'edit').fire('click');
  search(f, '暮色');
  f.nodes.cancel.fire('click');
  assert.equal(f.doc.activeElement, f.nodes.search);
  assert.deepEqual(f.nodes.search.focusOptions, { preventScroll: true });
  assert.deepEqual(f.nodes.search.scrollCalls, [{ block: 'center', inline: 'nearest' }]);

  search(f, '');
  f.action(markId(1), 'edit').fire('click');
  f.nodes.filter.value = 'zeta'; f.nodes.filter.fire('change');
  f.nodes.cancel.fire('click');
  assert.equal(f.doc.activeElement, f.nodes.filter);
  assert.deepEqual(f.nodes.filter.scrollCalls, [{ block: 'center', inline: 'nearest' }], '无查询时明确取消可见地回到作品筛选');

  f.nodes.filter.value = ''; f.nodes.filter.fire('change');
  search(f, '晨光');
  f.action(markId(1), 'read').focus();
  f.storage.values.set(noteKey(1), JSON.stringify({ version: 1, note: '远方', updatedAt: 40 }));
  f.win.fire('storage', { key: noteKey(1) });
  assert.equal(f.nodes.list.hidden, true);
  assert.equal(f.doc.activeElement, f.nodes.search);
  assert.deepEqual(f.nodes.search.focusOptions, { preventScroll: true });
  assert.equal(f.nodes.search.scrollCalls.length, 1, '外部备注导致失配时，不重复居中并拉动读者页面');

  search(f, '');
  f.action(markId(2), 'read').focus();
  f.storage.values.set(favoriteKey, JSON.stringify([markId(1)]));
  f.win.fire('storage', { key: favoriteKey });
  assert.equal(f.doc.activeElement, f.nodes.filter);
  assert.deepEqual(f.nodes.filter.focusOptions, { preventScroll: true });
  assert.equal(f.nodes.filter.scrollCalls.length, 1, '外部移除书签时作品筛选回退同样不滚动');
  assert.deepEqual(f.storage.writes, []);
  f.controller.destroy();
});

test('销毁移除搜索监听，重挂沿用页面查询并只绑定一份输入事件', () => {
  const f = fixture({ searchValue: '第一条', records: {
    [favoriteKey]: [markId(1), markId(2)],
    [noteKey(1)]: { version: 1, note: '第一条', updatedAt: 1 },
    [noteKey(2)]: { version: 1, note: '第二条', updatedAt: 1 },
  } });
  assert.deepEqual(visibleIds(f), [markId(1)]);
  f.controller.destroy();
  const before = [...f.nodes.list.children];
  search(f, '第二条');
  assert.deepEqual(f.nodes.list.children, before, '旧视图销毁后不能响应输入');
  let renders = 0;
  const replaceChildren = f.nodes.list.replaceChildren.bind(f.nodes.list);
  f.nodes.list.replaceChildren = (...children) => { renders++; replaceChildren(...children); };
  const mounted = mountBookmarkLibrary(f.root, { store: f.store });
  assert.equal(f.nodes.search.value, '第二条');
  assert.deepEqual(visibleIds(f), [markId(2)]);
  const reads = f.storage.reads;
  renders = 0;
  search(f, '第一条');
  assert.deepEqual(visibleIds(f), [markId(1)]);
  assert.equal(renders, 1, '重挂后一次输入只应渲染新视图一次');
  assert.equal(f.storage.reads, reads);
  assert.deepEqual(f.storage.writes, []);
  mounted.destroy();
});

test('缺少搜索标记时仍可显示和筛选已有页书签', () => {
  const f = fixture({ withoutSearch: true, records: { [favoriteKey]: [markId(1)] } });
  assert.deepEqual(visibleIds(f), [markId(1)]);
  f.nodes.filter.value = 'zeta'; f.nodes.filter.fire('change');
  assert.equal(f.nodes.list.hidden, true);
  assert.doesNotThrow(() => f.controller.destroy());
});
