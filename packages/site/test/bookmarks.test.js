import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAVORITES_PREFIX, NOTE_PREFIX, MAX_NOTE_LENGTH, createBookmarkStore, getReaderBookmarkStore } from '../src/lib/bookmarks.js';

const chapter = 'sample/v/c';
const favoriteKey = FAVORITES_PREFIX + chapter;
const id = (n) => `${chapter}/p${n}`;
const noteKey = (n) => NOTE_PREFIX + id(n);
const noteRecord = (note, updatedAt = 10, version = 1) => JSON.stringify({ version, note, updatedAt });

function fixture(records = {}) {
  const data = new Map(Object.entries(records));
  const operations = [];
  const f = { data, operations, readDenied: false, writeDenied: false, removeDenied: false, deniedKey: '', writeDeniedKey: '' };
  f.storage = {
    getItem(key) {
      operations.push(['get', key]);
      if (f.readDenied || key === f.deniedKey) throw new Error('read denied');
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      operations.push(['set', key]);
      if (f.writeDenied || key === f.deniedKey || key === f.writeDeniedKey) throw new Error('quota exceeded');
      data.set(key, value);
    },
    removeItem(key) {
      operations.push(['remove', key]);
      if (f.removeDenied || key === f.deniedKey) throw new Error('remove denied');
      data.delete(key);
    },
  };
  f.store = createBookmarkStore({ getStorage: () => f.storage, now: () => 25 });
  return f;
}

test('页码书签兼容旧收藏，仅返回当前话有效页，读取不写入或迁移记录', () => {
  const f = fixture({
    [favoriteKey]: JSON.stringify([id(3), id(1), id(3), 'other/v/c/p2', id(0), id(7), id('01'), id('1.5'), id('2#x'), 2, null]),
    [noteKey(1)]: noteRecord('旧收藏的新备注', 5),
    [noteKey(3)]: noteRecord('未来版本', 5, 2),
  });
  const before = new Map(f.data);
  assert.deepEqual(f.store.list(chapter, 6), [
    { n: 1, note: '旧收藏的新备注', updatedAt: 5 }, { n: 3, note: '', updatedAt: 0 },
  ]);
  assert.deepEqual(f.data, before);
  assert.ok(f.operations.every(([operation]) => operation === 'get'));
  assert.equal(f.store.limited, false);
});

test('书签备注按页保存原文并限制为 200 字符，返回对象不能修改保存内容', () => {
  const f = fixture();
  const text = '<script>保留为文字</script>\n下一行';
  assert.deepEqual(f.store.set(chapter, 6, 2, text), { persisted: true });
  assert.deepEqual(JSON.parse(f.data.get(favoriteKey)), [id(2)]);
  assert.deepEqual(JSON.parse(f.data.get(noteKey(2))), { version: 1, note: text, updatedAt: 25 });
  const entry = f.store.list(chapter, 6)[0];
  entry.note = '不能改写';
  assert.equal(f.store.list(chapter, 6)[0].note, text);
  assert.equal(MAX_NOTE_LENGTH, 200);
  f.store.set(chapter, 6, 2, '字'.repeat(200));
  const before = new Map(f.data);
  assert.throws(() => f.store.set(chapter, 6, 2, '字'.repeat(201)), TypeError);
  assert.deepEqual(f.data, before);
});

test('取消书签同时移除备注，保留其他页、进度、作品收藏和其他章节', () => {
  const f = fixture({
    [favoriteKey]: JSON.stringify([id(1), id(2)]), [noteKey(1)]: noteRecord('删除'), [noteKey(2)]: noteRecord('保留'),
    'gallery:progress:sample/v/c': '{"n":4}', 'gallery:library:sample': '{"status":"reading"}',
    'gallery:favorites:other/v/c': '["other/v/c/p1"]',
  });
  const before = new Map(f.data);
  assert.deepEqual(f.store.remove(chapter, 6, 1), { persisted: true });
  before.set(favoriteKey, JSON.stringify([id(2)]));
  before.delete(noteKey(1));
  assert.deepEqual(f.data, before);
  assert.deepEqual(f.store.list(chapter, 6), [{ n: 2, note: '保留', updatedAt: 10 }]);
});

test('增强收藏替换复用成员数组，保留仍收藏页备注并删除被取消页备注', () => {
  const f = fixture({
    [favoriteKey]: JSON.stringify([id(1), id(2)]), [noteKey(1)]: noteRecord('删掉'), [noteKey(2)]: noteRecord('留下', 15),
  });
  assert.deepEqual(f.store.replace(chapter, 6, [id(3), id(2), id(3), 'https://outside.example.org/', id(9)]), { persisted: true });
  assert.deepEqual(JSON.parse(f.data.get(favoriteKey)), [id(2), id(3)]);
  assert.equal(f.data.has(noteKey(1)), false);
  assert.deepEqual(f.store.list(chapter, 6), [{ n: 2, note: '留下', updatedAt: 15 }, { n: 3, note: '', updatedAt: 0 }]);
  assert.ok(!f.operations.some(([operation, key]) => operation === 'remove' && key === noteKey(3)));
});

test('无效章节、页数、页码和备注在访问存储前被拒绝', () => {
  const f = fixture();
  for (const key of ['', 'sample/v', '../v/c', 'Sample/v/c', 'a'.repeat(64) + '/v/c', null, {}]) {
    assert.deepEqual(f.store.list(key, 6), []);
    assert.throws(() => f.store.set(key, 6, 1), TypeError);
    assert.throws(() => f.store.remove(key, 6, 1), TypeError);
    assert.throws(() => f.store.replace(key, 6, []), TypeError);
  }
  for (const total of [0, -1, 1.5, '6', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(f.store.list(chapter, total), []);
    assert.throws(() => f.store.set(chapter, total, 1), TypeError);
  }
  for (const n of [undefined, null, 0, -1, 7, 1.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.store.set(chapter, 6, n), TypeError);
    assert.throws(() => f.store.remove(chapter, 6, n), TypeError);
  }
  assert.throws(() => f.store.set(chapter, 6, 1, null), TypeError);
  assert.throws(() => f.store.replace(chapter, 6, {}), TypeError);
  assert.deepEqual(f.operations, []);
});

test('坏成员数组与无效备注分别忽略，不阻断其他页也不清理原始记录', () => {
  for (const raw of ['{broken', '{}', 'null', '1']) {
    const f = fixture({ [favoriteKey]: raw });
    assert.deepEqual(f.store.list(chapter, 6), []);
    assert.equal(f.data.get(favoriteKey), raw);
  }
  for (const raw of ['{broken', '[]', 'null', noteRecord('未来', 1, 3), noteRecord('长'.repeat(201)), noteRecord('时间', -1)]) {
    const f = fixture({ [favoriteKey]: JSON.stringify([id(1), id(2)]), [noteKey(1)]: raw, [noteKey(2)]: noteRecord('有效') });
    assert.deepEqual(f.store.list(chapter, 6), [{ n: 1, note: '', updatedAt: 0 }, { n: 2, note: '有效', updatedAt: 10 }]);
    assert.equal(f.data.get(noteKey(1)), raw);
    assert.ok(f.operations.every(([operation]) => operation === 'get'));
  }
});

test('存储 getter 或读取失败时仅在本页修改，不盲目覆盖不可读取的旧收藏', () => {
  const denied = createBookmarkStore({ getStorage: () => { throw new Error('denied'); }, now: () => 2 });
  assert.deepEqual(denied.list(chapter, 6), []);
  assert.deepEqual(denied.set(chapter, 6, 1, '临时'), { persisted: false });
  assert.deepEqual(denied.list(chapter, 6), [{ n: 1, note: '临时', updatedAt: 2 }]);
  assert.deepEqual(denied.remove(chapter, 6, 1), { persisted: false });
  assert.deepEqual(denied.list(chapter, 6), []);
  assert.equal(denied.limited, true);
  const f = fixture({ [favoriteKey]: JSON.stringify([id(4)]) });
  f.readDenied = true;
  assert.deepEqual(f.store.set(chapter, 6, 2, '新增'), { persisted: false });
  assert.equal(f.data.get(favoriteKey), JSON.stringify([id(4)]));
  assert.ok(!f.operations.some(([operation]) => operation !== 'get'));
  f.readDenied = false;
  assert.deepEqual(f.store.list(chapter, 6).map((entry) => entry.n), [2, 4]);
  assert.deepEqual(f.store.set(chapter, 6, 2, '重试'), { persisted: true });
  assert.deepEqual(JSON.parse(f.data.get(favoriteKey)), [id(2), id(4)]);
});

test('成员写入失败保留本页结果，重试合并其他标签页的新收藏，成功后不遮挡新持久值', () => {
  const f = fixture({ [favoriteKey]: JSON.stringify([id(1)]) });
  f.writeDeniedKey = favoriteKey;
  assert.deepEqual(f.store.set(chapter, 6, 2, '临时新增'), { persisted: false });
  assert.deepEqual(f.store.list(chapter, 6).map((entry) => entry.n), [1, 2]);
  f.data.set(favoriteKey, JSON.stringify([id(1), id(3)]));
  f.writeDeniedKey = '';
  assert.deepEqual(f.store.set(chapter, 6, 2, '重试'), { persisted: true });
  assert.deepEqual(JSON.parse(f.data.get(favoriteKey)), [id(1), id(2), id(3)]);
  f.data.set(favoriteKey, JSON.stringify([id(4)]));
  assert.deepEqual(f.store.list(chapter, 6), [{ n: 4, note: '', updatedAt: 0 }]);
});

test('部分备注保存失败时显示完整本页结果，成功重试后读取其他标签页的备注', () => {
  const f = fixture();
  f.writeDeniedKey = noteKey(2);
  assert.deepEqual(f.store.set(chapter, 6, 2, '未完全保存'), { persisted: false });
  assert.deepEqual(JSON.parse(f.data.get(favoriteKey)), [id(2)]);
  assert.deepEqual(f.store.list(chapter, 6), [{ n: 2, note: '未完全保存', updatedAt: 25 }]);
  f.writeDeniedKey = '';
  assert.deepEqual(f.store.set(chapter, 6, 2, '已重试'), { persisted: true });
  f.data.set(noteKey(2), noteRecord('其他标签页', 30));
  assert.deepEqual(f.store.list(chapter, 6), [{ n: 2, note: '其他标签页', updatedAt: 30 }]);
});

test('删除失败在本页隐藏旧书签与备注，其他标签页的独立书签仍能显示', () => {
  const f = fixture({ [favoriteKey]: JSON.stringify([id(1)]), [noteKey(1)]: noteRecord('旧备注') });
  f.writeDenied = true;
  f.removeDenied = true;
  assert.deepEqual(f.store.remove(chapter, 6, 1), { persisted: false });
  assert.deepEqual(f.store.list(chapter, 6), []);
  f.data.set(favoriteKey, JSON.stringify([id(1), id(3)]));
  assert.deepEqual(f.store.list(chapter, 6), [{ n: 3, note: '', updatedAt: 0 }]);
  f.writeDenied = false;
  f.removeDenied = false;
  assert.deepEqual(f.store.remove(chapter, 6, 1), { persisted: true });
  assert.equal(f.data.has(noteKey(1)), false);
  assert.deepEqual(JSON.parse(f.data.get(favoriteKey)), [id(3)]);
});

test('操作通知、解绑和阅读页共享实例不引入初始化写入', () => {
  const f = fixture();
  const reader = { ownerDocument: { defaultView: { localStorage: f.storage } } };
  const shared = getReaderBookmarkStore(reader);
  assert.equal(getReaderBookmarkStore(reader), shared);
  assert.deepEqual(f.operations, []);
  const events = [];
  const unsubscribe = shared.subscribe((event) => events.push(event));
  shared.subscribe(() => { throw new Error('失效视图'); });
  assert.throws(() => shared.subscribe(null), TypeError);
  shared.list(chapter, 6);
  assert.deepEqual(events, []);
  shared.replace(chapter, 6, [id(1)]);
  shared.set(chapter, 6, 1, '编辑');
  assert.deepEqual(events, [{ chapterKey: chapter }, { chapterKey: chapter }]);
  unsubscribe();
  shared.remove(chapter, 6, 1);
  assert.equal(events.length, 2);
});
