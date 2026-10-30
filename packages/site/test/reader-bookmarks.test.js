import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountReaderBookmarks } from '../src/lib/reader-bookmarks.js';
import { FAVORITES_PREFIX, NOTE_PREFIX, MAX_NOTE_LENGTH } from '../src/lib/bookmarks.js';

const CHAPTER = 'sample/v/c';
const FAVORITES = FAVORITES_PREFIX + CHAPTER;
const noteKey = (n) => `${NOTE_PREFIX}${CHAPTER}/p${n}`;
const pageId = (n) => `${CHAPTER}/p${n}`;
const savedNote = (note) => ({ version: 1, note, updatedAt: 10 });

function element() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    hidden: false, value: '', textContent: '',
    set innerHTML(_value) { throw new Error('书签备注只能作为纯文本显示'); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    fire(type, properties = {}) {
      const event = { target: this, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; }, ...properties };
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
      return event;
    },
    focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; },
  };
}

function fixture({ records = {}, page = 2, requestedPage = page, denied = false, total = 6 } = {}) {
  const data = new Map(Object.entries(records).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const writes = [];
  const storage = {
    denyWrite: false, reads: [],
    getItem(key) { this.reads.push(key); return data.get(key) ?? null; },
    setItem(key, value) {
      if (this.denyWrite) throw new Error('Storage denied');
      writes.push(['set', key]); data.set(key, value);
    },
    removeItem(key) {
      if (this.denyWrite) throw new Error('Storage denied');
      writes.push(['remove', key]); data.delete(key);
    },
  };
  const win = element();
  const timers = new Map();
  let timerId = 0;
  win.setTimeout = (callback) => { timers.set(++timerId, callback); return timerId; };
  win.clearTimeout = (id) => timers.delete(id);
  const flushTimers = () => {
    for (const [id, callback] of [...timers]) if (timers.delete(id)) callback();
  };
  Object.defineProperty(win, 'localStorage', { get() { if (denied) throw new Error('Storage denied'); return storage; } });
  const doc = { defaultView: win, activeElement: null };
  const nodes = Object.fromEntries(['page', 'toggle', 'edit', 'editor', 'editing-page', 'note', 'current-note', 'save', 'cancel', 'message']
    .map((key) => [key, element()]));
  const root = element();
  root.hidden = true;
  root.querySelector = (selector) => nodes[selector.slice('[data-bookmark-'.length, -1)];
  nodes.editor.hidden = true;
  for (const node of [root, win, ...Object.values(nodes)]) node.ownerDocument = doc;
  let state = { page, requestedPage };
  const subscribers = new Set();
  const reader = {
    ownerDocument: doc,
    dataset: { key: CHAPTER, total: String(total) },
    galleryReader: {
      getState: () => state,
      subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    },
  };
  const controller = mountReaderBookmarks(reader, root);
  return {
    root, nodes, doc, win, reader, controller, data, storage, writes, subscribers, timers, flushTimers,
    turn(n, requested = n) {
      state = { page: n, requestedPage: requested };
      for (const subscriber of [...subscribers]) subscriber(state);
    },
    marks: () => JSON.parse(data.get(FAVORITES) ?? '[]'),
  };
}

test('阅读器书签读取旧收藏与备注，仅显示当前页且不回写存储', () => {
  const progress = JSON.stringify({ url: `/${CHAPTER}/`, n: 2, ts: 1 });
  const f = fixture({ records: {
    [FAVORITES]: [pageId(2), 'obsolete-page', 7],
    [noteKey(2)]: savedNote('<b>喜欢这个画面</b>'),
    [`gallery:progress:${CHAPTER}`]: progress,
  } });
  const before = [...f.data];
  assert.equal(f.root.hidden, false);
  assert.equal(f.nodes.page.textContent, '第 2 页');
  assert.equal(f.nodes.toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(f.nodes['current-note'].textContent, '<b>喜欢这个画面</b>');
  assert.equal(f.nodes['current-note'].hidden, false);
  assert.equal(f.nodes.edit.textContent, '编辑备注');
  f.turn(3);
  assert.equal(f.nodes.toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(f.nodes['current-note'].hidden, true);
  assert.deepEqual(f.writes, []);
  assert.deepEqual([...f.data], before);
});

test('阅读器书签使用 core.page，而非双页归并前的 requestedPage，取消不删除进度', () => {
  const progressKey = `gallery:progress:${CHAPTER}`;
  const f = fixture({ page: 3, requestedPage: 4, records: { [progressKey]: { n: 3, ts: 10 } } });
  const progress = f.data.get(progressKey);
  f.nodes.toggle.fire('click');
  assert.deepEqual(f.marks(), [pageId(3)]);
  assert.equal(f.nodes.page.textContent, '第 3 页');
  assert.equal(f.nodes.toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(f.doc.activeElement, f.nodes.toggle);
  f.nodes.toggle.fire('click');
  assert.deepEqual(f.marks(), []);
  assert.equal(f.data.has(noteKey(3)), false);
  assert.equal(f.data.get(progressKey), progress);
});

test('阅读器备注编辑固定原页，翻页和外部更新不覆盖草稿，保存仍写编辑页', () => {
  const f = fixture();
  f.nodes.edit.fire('click');
  assert.equal(f.nodes.editor.hidden, false);
  assert.equal(f.nodes['editing-page'].textContent, '第 2 页');
  f.nodes.note.value = '保留的草稿';
  f.turn(5);
  f.data.set(FAVORITES, JSON.stringify([pageId(2)]));
  f.data.set(noteKey(2), JSON.stringify(savedNote('另一个标签页的备注')));
  f.win.fire('storage', { key: noteKey(2) });
  f.win.fire('pageshow');
  f.nodes.edit.fire('click');
  assert.equal(f.nodes.page.textContent, '第 5 页');
  assert.equal(f.nodes['editing-page'].textContent, '第 2 页');
  assert.equal(f.nodes.note.value, '保留的草稿');
  assert.deepEqual(f.writes, [], '翻页、外部刷新和重复打开编辑均不自动保存');
  f.nodes.save.fire('click');
  assert.equal(f.nodes.editor.hidden, true);
  assert.deepEqual(f.marks(), [pageId(2)]);
  assert.equal(JSON.parse(f.data.get(noteKey(2))).note, '保留的草稿');
  assert.equal(f.data.has(noteKey(5)), false);
  assert.match(f.nodes.message.textContent, /已保存第 2 页/);
});

test('阅读器备注取消与 Escape 丢弃草稿，均不自动保存', () => {
  const f = fixture({ records: { [FAVORITES]: [pageId(2)], [noteKey(2)]: savedNote('原备注') } });
  const before = [...f.data];
  for (const type of ['cancel', 'escape']) {
    f.nodes.edit.fire('click');
    assert.equal(f.nodes.note.value, '原备注');
    f.nodes.note.value = '不保存的修改';
    if (type === 'cancel') f.nodes.cancel.fire('click');
    else {
      const event = f.nodes.editor.fire('keydown', { key: 'Escape', target: f.nodes.note });
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.stopped, true, 'Escape 不再传给背景阅读器');
    }
    assert.equal(f.nodes.editor.hidden, true);
    assert.equal(f.doc.activeElement, f.nodes.edit);
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual([...f.data], before);
});

test('阅读器备注拒绝程序输入的超长内容，缩短到上限后才保存', () => {
  const f = fixture();
  f.nodes.edit.fire('click');
  f.nodes.note.value = '字'.repeat(MAX_NOTE_LENGTH + 1);
  f.nodes.save.fire('click');
  assert.equal(f.nodes.editor.hidden, false);
  assert.match(f.nodes.message.textContent, /最多 200 字符/);
  assert.equal(f.doc.activeElement, f.nodes.note);
  assert.deepEqual(f.writes, []);
  f.nodes.note.value = '字'.repeat(MAX_NOTE_LENGTH);
  f.nodes.save.fire('click');
  assert.equal(f.nodes.editor.hidden, true);
  assert.equal(JSON.parse(f.data.get(noteKey(2))).note.length, MAX_NOTE_LENGTH);
});

test('阅读器书签存储访问或写入被拒绝时，本页继续显示临时修改和反馈', () => {
  for (const denied of [true, false]) {
    const f = fixture({ denied });
    f.storage.denyWrite = true;
    const before = [...f.data];
    f.nodes.edit.fire('click');
    f.nodes.note.value = '临时备注';
    f.nodes.save.fire('click');
    assert.match(f.nodes.message.textContent, /(?:存储受限|未能完整保存).*当前页面临时保留/);
    assert.equal(f.nodes.toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(f.nodes['current-note'].textContent, '临时备注');
    f.turn(4);
    f.turn(2);
    assert.equal(f.nodes['current-note'].textContent, '临时备注');
    f.nodes.toggle.fire('click');
    assert.equal(f.nodes.toggle.getAttribute('aria-pressed'), 'false');
    assert.deepEqual([...f.data], before);
  }
});

test('阅读器书签先保存成功后共享存储写入失败，不再显示旧的成功反馈', () => {
  const f = fixture();
  f.nodes.toggle.fire('click');
  assert.match(f.nodes.message.textContent, /已收藏第 2 页/);
  const before = [...f.data];
  f.storage.denyWrite = true;
  const result = f.reader.galleryBookmarkStore.set(CHAPTER, 6, 2, '来自共享书签状态的临时备注');
  assert.equal(result.persisted, false);
  assert.equal(f.nodes['current-note'].textContent, '来自共享书签状态的临时备注');
  assert.match(f.nodes.message.textContent, /存储受限.*当前页面临时保留/);
  assert.doesNotMatch(f.nodes.message.textContent, /已收藏|已保存/);
  assert.deepEqual([...f.data], before);
});

test('阅读器书签跨标签刷新不写入，销毁后解绑阅读器、存储与交互监听', () => {
  const f = fixture();
  f.data.set(FAVORITES, JSON.stringify([pageId(2)]));
  f.win.fire('storage', { key: 'unrelated-preference' });
  assert.equal(f.nodes.toggle.getAttribute('aria-pressed'), 'false');
  f.win.fire('storage', { key: FAVORITES });
  f.flushTimers();
  assert.equal(f.nodes.toggle.getAttribute('aria-pressed'), 'true');
  f.data.set(noteKey(2), JSON.stringify(savedNote('来自其他标签页')));
  f.win.fire('storage', { key: noteKey(2) });
  f.flushTimers();
  assert.equal(f.nodes['current-note'].textContent, '来自其他标签页');
  f.data.set(FAVORITES, '[]');
  f.win.fire('pageshow');
  assert.equal(f.nodes.toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(f.writes, []);
  const oldPage = f.nodes.page.textContent;
  f.controller.destroy();
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.win.listenerCount('storage'), 0);
  assert.equal(f.win.listenerCount('pageshow'), 0);
  f.turn(4);
  f.win.fire('storage', { key: null });
  f.nodes.toggle.fire('click');
  f.nodes.edit.fire('click');
  assert.equal(f.nodes.page.textContent, oldPage);
  assert.equal(f.nodes.editor.hidden, true);
  assert.deepEqual(f.writes, []);
});

test('阅读页的五百个收藏只读当前页备注，批量事件合并且保留编辑草稿', () => {
  const records = { [FAVORITES]: Array.from({ length: 500 }, (_, i) => pageId(i + 1)) };
  for (let n = 1; n <= 500; n++) records[noteKey(n)] = savedNote(`备注${n}`);
  const f = fixture({ records, total: 500 });
  f.storage.reads.length = 0;
  f.turn(3);
  assert.deepEqual(f.storage.reads, [FAVORITES, noteKey(3)], '翻页不能扫描其他499条备注');
  f.nodes.edit.fire('click');
  f.nodes.note.value = '当前编辑草稿';
  f.nodes.note.focus();
  f.storage.reads.length = 0;
  for (let i = 0; i < 500; i++) {
    f.data.set(noteKey(3), JSON.stringify(savedNote(`外部备注${i}`)));
    f.win.fire('storage', { key: noteKey(3) });
  }
  assert.deepEqual(f.storage.reads, []);
  assert.equal(f.timers.size, 1);
  f.flushTimers();
  assert.deepEqual(f.storage.reads, [FAVORITES, noteKey(3)]);
  assert.equal(f.nodes['current-note'].textContent, '外部备注499');
  assert.equal(f.nodes.note.value, '当前编辑草稿');
  assert.equal(f.doc.activeElement, f.nodes.note);
  const reads = f.storage.reads.length;
  for (let n = 4; n <= 500; n++) f.win.fire('storage', { key: noteKey(n) });
  assert.equal(f.timers.size, 0, '非当前页备注变化不排队');
  assert.equal(f.storage.reads.length, reads);
  assert.deepEqual(f.writes, []);
  f.controller.destroy();
});

test('阅读器翻页及窗口恢复立即读取，取消排队并隔离销毁前迟到任务', () => {
  const f = fixture({ records: { [FAVORITES]: [pageId(2)], [noteKey(2)]: savedNote('现有备注') } });
  for (const update of [() => f.turn(2), () => f.win.fire('focus'), () => f.win.fire('pageshow')]) {
    f.win.fire('storage', { key: FAVORITES });
    const stale = [...f.timers.values()][0];
    f.storage.reads.length = 0;
    update();
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.storage.reads, [FAVORITES, noteKey(2)]);
    stale(); f.flushTimers();
    assert.equal(f.storage.reads.length, 2);
  }
  f.win.fire('storage', { key: FAVORITES });
  const stale = [...f.timers.values()][0];
  f.controller.destroy();
  const mounted = mountReaderBookmarks(f.reader, f.root);
  const reads = f.storage.reads.length;
  stale(); f.flushTimers();
  assert.equal(f.storage.reads.length, reads);
  assert.equal(f.win.listenerCount('storage'), 1);
  assert.equal(f.win.listenerCount('focus'), 1);
  mounted.destroy();
  assert.equal(f.win.listenerCount('focus'), 0);
});
