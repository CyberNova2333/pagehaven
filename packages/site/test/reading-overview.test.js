import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountReadingOverview } from '../src/lib/reading-overview.js';

const fieldNames = ['savedSeries', 'progressSeries', 'progressChapters', 'bookmarks', 'notes'];
const library = (changes = {}) => ({ savedSeries: 2, progressSeries: 3, progressChapters: 4, limited: false, pending: false, ...changes });
const bookmarks = (changes = {}) => ({ bookmarks: 5, notes: 1, limited: false, pending: false, ...changes });

function node() {
  let value = '未初始化';
  return {
    updates: 0,
    get textContent() { return value; },
    set textContent(text) { value = text; this.updates++; },
    set innerHTML(_value) { throw new Error('概览只能写文本'); },
  };
}

function fixture({ missing } = {}) {
  const fields = Object.fromEntries(fieldNames.map((name) => [name, node()]));
  const status = node();
  let hidden = false;
  const root = {
    visibilityUpdates: 0, queries: 0,
    get hidden() { return hidden; },
    set hidden(value) { hidden = value; this.visibilityUpdates++; },
    get ownerDocument() { throw new Error('概览不应请求浏览器存储或窗口'); },
    get children() { throw new Error('概览不应枚举或重算列表'); },
    querySelector(selector) {
      this.queries++;
      if (selector === '[data-overview-status]') return missing === 'status' ? null : status;
      const name = /^\[data-overview-field="([^"]+)"\]$/.exec(selector)?.[1];
      return name === missing ? null : fields[name] ?? null;
    },
  };
  const api = mountReadingOverview(root);
  return { root, fields, status, api,
    values: () => fieldNames.map((name) => fields[name].textContent),
    writes: () => [...fieldNames.map((name) => fields[name].updates), status.updates, root.visibilityUpdates],
  };
}

test('概览等两源有效后才显示，来源先后和真实零值均不影响结果', () => {
  for (const libraryFirst of [true, false]) {
    const f = fixture();
    assert.equal(f.root.hidden, true);
    assert.deepEqual(f.values(), Array(5).fill('—'));
    assert.equal(f.status.textContent, '');
    const updates = libraryFirst
      ? [() => f.api.updateLibrary(library()), () => f.api.updateBookmarks(bookmarks())]
      : [() => f.api.updateBookmarks(bookmarks()), () => f.api.updateLibrary(library())];
    updates[0]();
    assert.equal(f.root.hidden, true);
    assert.equal(f.status.textContent, '');
    updates[1]();
    assert.equal(f.root.hidden, false);
    assert.deepEqual(f.values(), ['2', '3', '4', '5', '1']);
    assert.equal(f.status.textContent, '当前目录可用记录。');
    f.api.updateLibrary(library({ savedSeries: 0, progressSeries: 0, progressChapters: 0 }));
    f.api.updateBookmarks(bookmarks({ bookmarks: 0, notes: 0 }));
    assert.equal(f.root.hidden, false);
    assert.deepEqual(f.values(), Array(5).fill('0'));
    assert.equal(f.root.queries, 6, '更新只用挂载时找到的字段，不重新枚举视图');
  }
});

test('存储受限与本页临时修改可来自不同视图，恢复后清除旧提示', () => {
  const f = fixture();
  f.api.updateLibrary(library({ limited: true }));
  f.api.updateBookmarks(bookmarks({ pending: true }));
  assert.match(f.status.textContent, /当前目录可用记录/);
  assert.match(f.status.textContent, /存储受限.*可能不完整/);
  assert.match(f.status.textContent, /本页未保存修改/);
  f.api.updateLibrary(library({ pending: true }));
  f.api.updateBookmarks(bookmarks({ limited: true }));
  assert.match(f.status.textContent, /存储受限.*本页未保存修改/);
  f.api.updateLibrary(library());
  f.api.updateBookmarks(bookmarks());
  assert.equal(f.status.textContent, '当前目录可用记录。');
  assert.doesNotMatch(f.status.textContent, /已保存|备份总量/);
});

test('汇总取提交时的快照，新更新覆盖旧数量而非累加，回调可脱离 this 调用', () => {
  const f = fixture();
  const { updateLibrary, updateBookmarks } = f.api;
  const before = library();
  updateLibrary(before);
  before.savedSeries = 999;
  before.limited = before.pending = true;
  updateBookmarks(bookmarks());
  assert.equal(f.fields.savedSeries.textContent, '2');
  assert.equal(f.status.textContent, '当前目录可用记录。');
  updateLibrary(library({ savedSeries: 1, progressSeries: 1, progressChapters: 2 }));
  updateBookmarks(bookmarks({ bookmarks: 2, notes: 0 }));
  assert.deepEqual(f.values(), ['1', '1', '2', '2', '0']);
});

test('重置用于备份重挂，两源重新提交前不混用上一轮数量', () => {
  const f = fixture();
  f.api.updateLibrary(library());
  f.api.updateBookmarks(bookmarks());
  f.api.reset();
  assert.equal(f.root.hidden, true);
  assert.deepEqual(f.values(), Array(5).fill('—'));
  assert.equal(f.status.textContent, '');
  f.api.updateBookmarks(bookmarks({ bookmarks: 8, notes: 3 }));
  assert.equal(f.root.hidden, true);
  assert.equal(f.fields.savedSeries.textContent, '—');
  f.api.updateLibrary(library({ savedSeries: 1 }));
  assert.equal(f.root.hidden, false);
  assert.deepEqual(f.values(), ['1', '3', '4', '8', '3']);
});

test('重复汇总不重写相同文本或重复播报，标志变化只改状态', () => {
  const f = fixture();
  f.api.updateLibrary(library());
  f.api.updateBookmarks(bookmarks());
  const writes = f.writes();
  f.api.updateLibrary(library());
  f.api.updateBookmarks(bookmarks());
  assert.deepEqual(f.writes(), writes);
  f.api.updateBookmarks(bookmarks({ pending: true }));
  assert.deepEqual(f.writes().slice(0, 5), writes.slice(0, 5));
  assert.equal(f.status.updates, writes[5] + 1);
});

test('非法数量或标志使对应来源等待重读，不显示旧值、NaN或伪零', () => {
  const f = fixture();
  f.api.updateLibrary(library());
  f.api.updateBookmarks(bookmarks());
  for (const bad of [null, [], 1, {}, ...[-1, 1.2, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1].map((savedSeries) => library({ savedSeries })),
    library({ limited: 'true' }), library({ pending: undefined }), { ...library(), get savedSeries() { throw new Error('坏属性'); } }]) {
    assert.doesNotThrow(() => f.api.updateLibrary(bad));
    assert.equal(f.root.hidden, true);
    assert.equal(f.fields.savedSeries.textContent, '—');
    assert.equal(f.fields.bookmarks.textContent, '5');
    assert.equal(f.status.textContent, '');
    f.api.updateLibrary(library());
    assert.equal(f.root.hidden, false);
  }
  for (const bad of [bookmarks({ notes: -1 }), bookmarks({ bookmarks: '2' }), bookmarks({ pending: null })]) {
    f.api.updateBookmarks(bad);
    assert.equal(f.root.hidden, true);
    assert.equal(f.fields.notes.textContent, '—');
    f.api.updateBookmarks(bookmarks());
    assert.equal(f.root.hidden, false);
  }
});

test('销毁幂等，更新及重置都不能重新激活已销毁的概览', () => {
  const f = fixture();
  f.api.updateLibrary(library());
  f.api.updateBookmarks(bookmarks());
  f.api.destroy();
  const writes = f.writes();
  assert.equal(f.root.hidden, true);
  assert.deepEqual(f.values(), Array(5).fill('—'));
  f.api.destroy();
  f.api.reset();
  f.api.updateLibrary(library());
  f.api.updateBookmarks(bookmarks());
  assert.equal(f.root.hidden, true);
  assert.deepEqual(f.writes(), writes);
});

test('必要标记缺失时不显示不完整概览，也不阻断其他界面', () => {
  for (const missing of ['notes', 'status']) {
    const f = fixture({ missing });
    assert.doesNotThrow(() => {
      f.api.updateLibrary(library());
      f.api.updateBookmarks(bookmarks());
    });
    assert.equal(f.root.hidden, true);
    f.api.destroy();
  }
});
