import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_PREFIX, READING_STATUSES, createLibraryStore, latestSeriesProgress } from '../src/lib/library.js';

function storageFixture(entries = []) {
  const data = new Map(entries);
  const operations = [];
  const storage = {
    getItem(key) { operations.push(['get', key]); return data.get(key) ?? null; },
    setItem(key, value) { operations.push(['set', key]); data.set(key, value); },
    removeItem(key) { operations.push(['remove', key]); data.delete(key); },
  };
  return { data, operations, storage };
}

const record = (status = 'want', updatedAt = 10) => ({ version: 1, status, updatedAt });
const serialized = (status, updatedAt) => JSON.stringify(record(status, updatedAt));
const progressKey = (chapter) => `gallery:progress:${chapter.key}`;
const chapter = (id, pages = 4) => ({ id, key: `sample/v/${id}`, url: `/sample/v/${id}/`, title: `目录 ${id}`, pages });
const series = (...chapters) => ({ id: 'sample', issues: [{ id: 'v', chapters }] });

test('书架状态：读取不落盘，只保存指定作品，正常写入后仍能读取其他标签页的更新', () => {
  const f = storageFixture([[LIBRARY_PREFIX + 'sample', serialized('want', 1)]]);
  const store = createLibraryStore({ getStorage: () => f.storage, now: () => 25 });
  assert.deepEqual(store.read('sample'), record('want', 1));
  assert.equal(store.read('other'), null);
  assert.ok(f.operations.every(([type]) => type === 'get'));
  assert.deepEqual(READING_STATUSES, [
    { value: 'want', label: '想读' }, { value: 'reading', label: '在读' }, { value: 'read', label: '已读' },
  ]);
  assert.deepEqual(store.set('sample', 'reading'), { persisted: true });
  assert.deepEqual(JSON.parse(f.data.get(LIBRARY_PREFIX + 'sample')), record('reading', 25));
  assert.equal(store.limited, false);
  f.data.set(LIBRARY_PREFIX + 'sample', serialized('read', 30));
  assert.deepEqual(store.read('sample'), record('read', 30), '成功保存后不能被本页旧缓存遮挡');
});

test('书架状态：坏记录、未知版本与状态被忽略，访问时不清理任何原始内容', () => {
  const invalid = ['{broken', 'null', '[]', '3', '{}',
    JSON.stringify({ ...record(), version: 2 }), JSON.stringify({ ...record(), status: 'done' }),
    JSON.stringify({ ...record(), updatedAt: -1 }), JSON.stringify({ ...record(), updatedAt: '10' }),
    JSON.stringify({ ...record(), updatedAt: 1.5 }), JSON.stringify({ ...record(), updatedAt: Number.MAX_SAFE_INTEGER + 1 }),
  ];
  for (const raw of invalid) {
    const f = storageFixture([[LIBRARY_PREFIX + 'sample', raw]]);
    const store = createLibraryStore({ getStorage: () => f.storage });
    assert.equal(store.read('sample'), null, raw);
    assert.equal(store.limited, false, '坏内容与存储不可访问分开处理');
    assert.equal(f.data.get(LIBRARY_PREFIX + 'sample'), raw);
    assert.deepEqual(f.operations, [['get', LIBRARY_PREFIX + 'sample']]);
  }
});

test('书架状态：非法作品与状态不写入，返回的记录不能修改当前页临时状态', () => {
  const f = storageFixture();
  const store = createLibraryStore({ getStorage: () => f.storage });
  for (const id of ['', '../sample', 'Sample', 'sample/v', 'a'.repeat(64), null, {}]) {
    assert.equal(store.read(id), null);
    assert.throws(() => store.set(id, 'want'), TypeError);
    assert.throws(() => store.remove(id), TypeError);
  }
  assert.throws(() => store.set('sample', 'done'), TypeError);
  assert.deepEqual(f.operations, []);
  const denied = createLibraryStore({ getStorage: () => { throw new Error('denied'); }, now: () => 1 });
  denied.set('sample', 'want');
  const returned = denied.read('sample');
  returned.status = 'read';
  assert.deepEqual(denied.read('sample'), record('want', 1));
});

test('书架状态：读取和取得存储被拒绝时不崩溃，写入与移除可在当前页继续', () => {
  for (const getStorage of [() => { throw new Error('denied'); }, () => ({
    getItem() { throw new Error('read denied'); },
    setItem() { throw new Error('write denied'); },
    removeItem() { throw new Error('remove denied'); },
  })]) {
    const store = createLibraryStore({ getStorage, now: () => 5 });
    assert.equal(store.read('sample'), null);
    assert.equal(store.limited, true);
    assert.deepEqual(store.set('sample', 'reading'), { persisted: false });
    assert.deepEqual(store.read('sample'), record('reading', 5));
    assert.deepEqual(store.remove('sample'), { persisted: false });
    assert.equal(store.read('sample'), null);
  }
});

test('书架状态：配额满或移除失败时临时结果覆盖旧记录，存储恢复后重新跟随持久状态', () => {
  const f = storageFixture([[LIBRARY_PREFIX + 'sample', serialized('want', 1)]]);
  let denied = true;
  const storage = { ...f.storage,
    setItem(key, value) { if (denied) throw new Error('quota'); f.storage.setItem(key, value); },
    removeItem(key) { if (denied) throw new Error('denied'); f.storage.removeItem(key); },
  };
  const store = createLibraryStore({ getStorage: () => storage, now: () => 20 });
  assert.deepEqual(store.set('sample', 'reading'), { persisted: false });
  assert.deepEqual(store.read('sample'), record('reading', 20));
  assert.deepEqual(JSON.parse(f.data.get(LIBRARY_PREFIX + 'sample')), record('want', 1));
  store.remove('sample');
  assert.equal(store.read('sample'), null, '移除失败后不能又显示磁盘旧记录');
  denied = false;
  assert.deepEqual(store.set('sample', 'read'), { persisted: true });
  f.data.set(LIBRARY_PREFIX + 'sample', serialized('want', 30));
  assert.deepEqual(store.read('sample'), record('want', 30));
});

test('书架状态：移出书架只删除作品状态，不删除进度或增强分页收藏', () => {
  const f = storageFixture([
    [LIBRARY_PREFIX + 'sample', serialized('read', 10)],
    ['gallery:progress:sample/v/c1', '{"url":"/sample/v/c1/","n":3}'],
    ['gallery:favorites:sample/v/c1', '["sample/v/c1/p3"]'],
    [LIBRARY_PREFIX + 'other', serialized('want', 5)],
  ]);
  const before = new Map(f.data);
  const store = createLibraryStore({ getStorage: () => f.storage });
  assert.deepEqual(store.remove('sample'), { persisted: true });
  before.delete(LIBRARY_PREFIX + 'sample');
  assert.deepEqual(f.data, before);
  assert.equal(store.read('sample'), null);
});

test('书架进度：从当前目录取最近章节和标题，旧页码限制到现有页数，读取不迁移数据', () => {
  const c1 = chapter('c1', [{}, {}, {}]);
  const c2 = chapter('c2', 2);
  const f = storageFixture([
    [progressKey(c1), JSON.stringify({ url: c1.url, n: 2, ts: 5 })],
    [progressKey(c2), JSON.stringify({ url: c2.url, n: 99, ts: 10, title: '过期标题' })],
    ['gallery:progress:sample/v/deleted', JSON.stringify({ url: '/sample/v/deleted/', n: 1, ts: 100 })],
  ]);
  const before = new Map(f.data);
  const latest = latestSeriesProgress(series(c1, c2), f.storage);
  assert.deepEqual(latest, { chapter: c2, n: 2, ts: 10 });
  assert.equal(latest.chapter, c2, '使用当前目录对象，不把存储标题和链接带入页面');
  assert.deepEqual(f.data, before);
  assert.deepEqual(f.operations, [['get', progressKey(c1)], ['get', progressKey(c2)]]);
});

test('书架进度：坏 JSON、单条读取异常和伪造 URL 不阻断后续有效章节', () => {
  const chapters = Array.from({ length: 8 }, (_, i) => chapter(`c${i + 1}`));
  const values = ['{broken', 'null', '[]',
    JSON.stringify({ url: 'javascript:alert(1)', n: 2, ts: 500 }),
    JSON.stringify({ url: chapters[4].url + '#p2', n: 2, ts: 600 }),
    JSON.stringify({ url: chapters[5].url + 'extra/', n: 2, ts: 700 }),
    JSON.stringify({ url: chapters[6].url, n: 3, ts: 800 }),
    JSON.stringify({ url: chapters[7].url, n: 2, ts: 10 }),
  ];
  const f = storageFixture(chapters.map((c, i) => [progressKey(c), values[i]]));
  const storage = { getItem(key) { if (key === progressKey(chapters[6])) throw new Error('read denied'); return f.storage.getItem(key); } };
  assert.deepEqual(latestSeriesProgress(series(...chapters), storage), { chapter: chapters[7], n: 2, ts: 10 });
});

test('书架进度：非法页码回第一页，安全整数页码钳制到当前章节范围', () => {
  const c = chapter('c1');
  for (const [n, expected] of [[undefined, 1], [null, 1], ['3', 1], [{}, 1], [[], 1], [1.5, 1],
    [0, 1], [-2, 1], [99, 4], [3, 3], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    const f = storageFixture([[progressKey(c), JSON.stringify({ url: c.url, n, ts: 10 })]]);
    assert.equal(latestSeriesProgress(series(c), f.storage).n, expected);
  }
});

test('书架进度：异常时间戳归零，目录后章在相同时间优先，零时间仍可恢复', () => {
  const c1 = chapter('c1');
  const c2 = chapter('c2');
  const f = storageFixture([
    [progressKey(c1), JSON.stringify({ url: c1.url, n: 2, ts: 10 })],
    [progressKey(c2), '{"url":"/sample/v/c2/","n":3,"ts":1e309}'],
  ]);
  assert.equal(latestSeriesProgress(series(c1, c2), f.storage).chapter, c1);
  for (const ts of ['999', -1, null]) {
    f.data.set(progressKey(c1), JSON.stringify({ url: c1.url, n: 2, ts }));
    assert.deepEqual(latestSeriesProgress(series(c1, c2), f.storage), { chapter: c2, n: 3, ts: 0 });
  }
});

test('书架进度：不接受其他作品、伪造目录链接或无效页数，也不扫描无关存储', () => {
  const c = chapter('c1');
  const invalid = [
    { ...c, key: 'other/v/c1', url: '/other/v/c1/' },
    { ...c, url: 'https://outside.example.org/sample/v/c1/' },
    { ...c, key: 'sample/v/../c1' }, { ...c, key: 'sample/V/c1', url: '/sample/V/c1/' },
    { ...c, id: 'other' }, { ...c, pages: 0 }, { ...c, pages: -1 }, { ...c, pages: '4' },
  ];
  const f = storageFixture([[progressKey(c), JSON.stringify({ url: c.url, n: 2, ts: 10 })]]);
  assert.equal(latestSeriesProgress(series(...invalid), f.storage), null);
  assert.equal(latestSeriesProgress({ id: 'sample', issues: [{ id: 'wrong', chapters: [c] }] }, f.storage), null);
  assert.equal(latestSeriesProgress({ id: 'sample', issues: [] }, f.storage), null);
  assert.equal(latestSeriesProgress({ id: 'Sample', issues: [{ chapters: [c] }] }, f.storage), null);
  assert.deepEqual(f.operations, []);
});
