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
    tag, children: [], dataset: {}, hidden: false, value: '', parentElement: null,
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

function fixture({ records = {}, data = catalog(), denied = false, autoFlushStorage = true } = {}) {
  const values = new Map(Object.entries(records).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]));
  const storage = {
    values, reads: 0, writes: [], denied,
    getItem(name) { this.reads++; return values.get(name) ?? null; },
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
  const names = ['list', 'empty', 'filter', 'count', 'storage-note', 'feedback', 'more', 'editor', 'editor-title', 'note', 'save', 'cancel', 'toolbar', 'catalog'];
  const nodes = Object.fromEntries(names.map((name) => [name, element(name)]));
  nodes.catalog.textContent = typeof data === 'string' ? data : JSON.stringify(data);
  nodes.editor.hidden = nodes.toolbar.hidden = true;
  root.querySelector = (selector) => nodes[selector === '[data-bookmark-toolbar]' ? 'toolbar'
    : selector === '#library-bookmark-note' ? 'note' : selector.slice('#bookmark-'.length)];
  const doc = { defaultView: win, activeElement: null,
    getElementById: (id) => id === 'library-catalog' ? nodes.catalog : null,
    createElement(tag) { const node = element(tag); node.ownerDocument = doc; return node; },
  };
  for (const node of [root, win, ...Object.values(nodes)]) node.ownerDocument = doc;
  const store = createBookmarkStore({ getStorage: () => storage, now: () => 30 });
  const controller = mountBookmarkLibrary(root, { store });
  const row = (id) => nodes.list.children.find((node) => node.dataset.bookmarkId === id);
  const action = (id, type) => row(id)?.querySelector(`[data-bookmark-action="${type}"]`);
  return { root, nodes, doc, win, store, storage, controller, row, action };
}

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
  assert.equal(f.nodes.list.hidden, true);
  assert.match(f.nodes.empty.textContent, /还没有页码书签/);
  assert.equal(f.nodes.toolbar.hidden, false);
  assert.deepEqual(f.storage.writes, []);
  f.controller.destroy();
  const invalid = fixture({ data: '{bad' });
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
