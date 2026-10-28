import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReadingImport, applyReadingImport } from '../src/lib/reading-backup.js';

const shelf = (status, updatedAt) => JSON.stringify({ version: 1, status, updatedAt });
const backup = () => ({
  format: 'pagehaven-reading-backup', version: 1, createdAt: 50,
  library: [{ seriesId: 'alpha', status: 'reading', updatedAt: 20 }, { seriesId: 'beta', status: 'read', updatedAt: 20 }],
  progress: [], bookmarks: [], notes: [],
});

function storageFixture(records, fail) {
  const data = new Map(records);
  return {
    data,
    get length() { return data.size; },
    key(n) { return [...data.keys()][n] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, raw) { fail?.(key, raw, data); data.set(key, raw); },
    removeItem(key) { data.delete(key); },
  };
}

test('导入回滚不覆盖另一窗口在写入失败期间保存的新值', () => {
  const original = shelf('want', 10);
  const concurrent = shelf('read', 30);
  const storage = storageFixture([
    ['gallery:library:alpha', original], ['unrelated-preference', 'keep'],
  ], (key, _raw, data) => {
    if (key === 'gallery:library:beta') {
      data.set('gallery:library:alpha', concurrent);
      throw new Error('Storage quota exceeded');
    }
  });
  const plan = planReadingImport(backup(), storage, { mode: 'use-backup' });
  const result = applyReadingImport(plan, storage);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false, '其他窗口的新值不能伪装成本次已经恢复');
  assert.equal(storage.getItem('gallery:library:alpha'), concurrent);
  assert.equal(storage.getItem('gallery:library:beta'), null);
  assert.equal(storage.getItem('unrelated-preference'), 'keep');
  assert.throws(() => applyReadingImport(plan, storage), /预览已失效/, '失败的计划也只能应用一次');
});

test('写入与回滚均被拒绝时报告未完全恢复，保留仍可检查的实际状态', () => {
  const original = shelf('want', 10);
  const storage = storageFixture([
    ['gallery:library:alpha', original], ['unrelated-preference', 'keep'],
  ], (key, raw) => {
    if (key === 'gallery:library:beta' || (key === 'gallery:library:alpha' && raw === original)) {
      throw new Error('Storage write denied');
    }
  });
  const plan = planReadingImport(backup(), storage, { mode: 'use-backup' });
  const result = applyReadingImport(plan, storage);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(storage.getItem('gallery:library:alpha'), shelf('reading', 20));
  assert.equal(storage.getItem('gallery:library:beta'), null);
  assert.equal(storage.getItem('unrelated-preference'), 'keep');
});
