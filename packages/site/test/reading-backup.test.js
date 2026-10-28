import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BACKUP_BYTES, MAX_BACKUP_RECORDS, exportReadingBackup, parseReadingBackup, planReadingImport, applyReadingImport } from '../src/lib/reading-backup.js';

const chapter = 'sample/v/c';
const libraryKey = 'gallery:library:sample';
const progressKey = 'gallery:progress:' + chapter;
const favoriteKey = 'gallery:favorites:' + chapter;
const pageId = (n) => chapter + '/p' + n;
const noteKey = (n) => 'gallery:bookmark-note:' + pageId(n);
const library = (status = 'want', updatedAt = 5) => ({ version: 1, status, updatedAt });
const note = (value = '本机备注', updatedAt = 5) => ({ version: 1, note: value, updatedAt });
const progress = (n = 1, ts = 5) => ({ url: '/' + chapter + '/', title: '旧标题', series: '旧作品', issue: '旧期', n, ts });
const catalog = [{ id: 'sample', title: '当前作品', issues: [{ id: 'v', title: '当前期', chapters: [{ key: chapter, title: '当前章节', url: '/' + chapter + '/', pages: 6 }] }] }];
const empty = () => ({ format: 'pagehaven-reading-backup', version: 1, createdAt: 100, library: [], progress: [], bookmarks: [], notes: [] });
function sample() {
  return { ...empty(), library: [{ seriesId: 'sample', status: 'reading', updatedAt: 10 }], progress: [{ chapterKey: chapter, n: 3, ts: 10 }], bookmarks: [{ chapterKey: chapter, pages: [2, 3] }], notes: [{ chapterKey: chapter, n: 2, note: '备份备注', updatedAt: 10 }] };
}
function fixture(records = {}) {
  const data = new Map(Object.entries(records).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const operations = [];
  const f = { data, operations, getHook: null, setHook: null, removeHook: null, writes: 0 };
  f.storage = {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { operations.push(['get', key]); f.getHook?.(key); return data.get(key) ?? null; },
    setItem(key, raw) { operations.push(['set', key]); f.writes++; f.setHook?.(key, raw); data.set(key, raw); },
    removeItem(key) { operations.push(['remove', key]); f.removeHook?.(key); data.delete(key); },
  };
  return f;
}
const written = (f) => f.operations.filter(([type]) => type !== 'get');

test('阅读备份仅导出四类已保存记录，保留旧目录与孤立备注，不读取其他存储值', () => {
  const f = fixture({ [libraryKey]: { ...library(), privateExtra: '不应导出' }, [progressKey]: progress(3), [favoriteKey]: [pageId(3), pageId(1)], [noteKey(1)]: note(), [noteKey(99)]: note('孤立备注'), 'gallery:library:old': library('read'), 'private-session': '不应读取', 'gallery:settings': '不应读取' });
  const before = new Map(f.data);
  const result = exportReadingBackup(f.storage, { now: () => 100 });
  assert.deepEqual(result.counts, { library: 2, progress: 1, bookmarks: 2, notes: 2 });
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.backup.bookmarks, [{ chapterKey: chapter, pages: [1, 3] }]);
  assert.deepEqual(result.backup.progress, [{ chapterKey: chapter, n: 3, ts: 5 }]);
  assert.ok(result.backup.notes.some((entry) => entry.n === 99));
  assert.doesNotMatch(JSON.stringify(result.backup), /不应|旧标题|旧作品|旧期/);
  assert.ok(f.operations.every(([type, key]) => type === 'get' && !['private-session', 'gallery:settings'].includes(key)));
  assert.deepEqual(f.data, before);
  assert.deepEqual(parseReadingBackup(JSON.stringify(result.backup)), result.backup);
});

test('阅读备份跳过坏记录和重复收藏并计数，合法部分仍能恢复', () => {
  const f = fixture({ [libraryKey]: library(), 'gallery:library:bad': library('invalid'), 'gallery:library:UPPER': '不读取非法键', [progressKey]: { ...progress(), url: 'https://other.example.org/' }, [favoriteKey]: [pageId(2), pageId(1), pageId(2), pageId('01'), 'other/v/c/p2', 3], [noteKey(1)]: note('x'.repeat(201)), [noteKey(4)]: note('仍保留') });
  const result = exportReadingBackup(f.storage, { now: () => 100 });
  assert.deepEqual(result.counts, { library: 1, progress: 0, bookmarks: 2, notes: 1 });
  assert.equal(result.skipped, 8);
  assert.ok(!f.operations.some(([, key]) => key === 'gallery:library:UPPER'));
  const target = fixture();
  assert.equal(applyReadingImport(planReadingImport(result.backup, target.storage), target.storage).ok, true);
  assert.deepEqual(JSON.parse(target.data.get(favoriteKey)), [pageId(1), pageId(2)]);
});

test('导出读取受限或检测到记录变化时失败，不声称生成完整备份', () => {
  const denied = fixture({ [libraryKey]: library() });
  denied.getHook = () => { throw new Error('read denied'); };
  assert.throws(() => exportReadingBackup(denied.storage), /read denied/);
  const changed = fixture({ [libraryKey]: library() });
  let reads = 0;
  changed.getHook = () => { if (++reads === 2) changed.data.set(libraryKey, JSON.stringify(library('read', 20))); };
  assert.throws(() => exportReadingBackup(changed.storage), /正在变化/);
  const excessive = { length: 100001, key() { throw new Error('不应遍历'); } };
  assert.throws(() => exportReadingBackup(excessive), /过多/);
  assert.deepEqual(written(denied), []);
  assert.deepEqual(written(changed), []);
});

test('备份解析校验格式、版本、严格字段、标识与页码，拒绝链接和任意存储键', () => {
  const invalid = [null, [], {}, { ...empty(), version: 2 }, { ...empty(), format: 'other' }, { ...empty(), extra: true }, { ...empty(), createdAt: -1 }, { ...empty(), library: [{ seriesId: 'UPPER', status: 'want', updatedAt: 0 }] }, { ...empty(), library: [{ seriesId: '__proto__', status: 'want', updatedAt: 0 }] }, { ...empty(), library: [{ seriesId: 'x'.repeat(64), status: 'want', updatedAt: 0 }] }, { ...empty(), progress: [{ chapterKey: '../v/c', n: 1, ts: 0 }] }, { ...empty(), progress: [{ chapterKey: chapter, n: 0, ts: 0 }] }, { ...empty(), progress: [{ chapterKey: chapter, n: 1.5, ts: 0 }] }, { ...empty(), progress: [{ chapterKey: chapter, n: 1, ts: 0, url: 'javascript:alert(1)' }] }, { ...empty(), notes: [{ chapterKey: chapter, n: 1, note: 'x'.repeat(201), updatedAt: 0 }] }, { ...empty(), notes: [{ chapterKey: chapter, n: 1, note: '', updatedAt: '0' }] }, { ...empty(), bookmarks: [{ chapterKey: chapter, pages: ['1'] }] }];
  for (const value of invalid) assert.throws(() => parseReadingBackup(JSON.stringify(value)));
  assert.throws(() => parseReadingBackup('{broken'), /有效的 JSON/);
  assert.deepEqual(parseReadingBackup('\uFEFF' + JSON.stringify(empty())), empty());
  assert.throws(() => planReadingImport({ ...sample(), storage: { key: 'private-session' } }, fixture().storage));
});

test('备份拒绝重复记录标识或重复页，避免含糊的覆盖顺序', () => {
  for (const type of ['library', 'progress', 'bookmarks', 'notes']) {
    const backup = sample();
    backup[type].push(structuredClone(backup[type][0]));
    assert.throws(() => parseReadingBackup(JSON.stringify(backup)), /重复/);
  }
  const backup = sample();
  backup.bookmarks[0].pages = [1, 1];
  assert.throws(() => parseReadingBackup(JSON.stringify(backup)), /重复/);
});

test('备份限制按UTF-8字节和每页逻辑记录计数，不按收藏章节数量计数', () => {
  assert.equal(MAX_BACKUP_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_BACKUP_RECORDS, 20000);
  assert.throws(() => parseReadingBackup('界'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3) + 1)), /超过/);
  const backup = empty();
  backup.bookmarks = [{ chapterKey: chapter, pages: Array.from({ length: MAX_BACKUP_RECORDS }, (_, i) => i + 1) }];
  assert.equal(parseReadingBackup(JSON.stringify(backup)).bookmarks[0].pages.length, MAX_BACKUP_RECORDS);
  backup.notes.push({ chapterKey: chapter, n: 1, note: '', updatedAt: 0 });
  assert.throws(() => parseReadingBackup(JSON.stringify(backup)), /超过/);
  const f = fixture({ [favoriteKey]: Array.from({ length: MAX_BACKUP_RECORDS + 1 }, (_, i) => pageId(i + 1)) });
  assert.throws(() => exportReadingBackup(f.storage), /超过/);
});

test('默认导入只合并页收藏，保留当前状态、进度与备注，预览绝不写入', () => {
  const f = fixture({ [libraryKey]: library('read'), [progressKey]: progress(5), [favoriteKey]: [pageId(1), pageId(2)], [noteKey(2)]: note(), 'private-session': 'untouched', 'gallery:library:other': library() });
  const plan = planReadingImport(sample(), f.storage, { catalog });
  assert.equal(plan.changes, 1);
  assert.equal(plan.unmatched, 0);
  assert.deepEqual(plan.counts.bookmarks, { added: 1, updated: 0, kept: 0, same: 1, repaired: 0 });
  for (const type of ['library', 'progress', 'notes']) assert.equal(plan.counts[type].kept, 1);
  assert.deepEqual(written(f), []);
  assert.equal(applyReadingImport(plan, f.storage).ok, true);
  assert.deepEqual(JSON.parse(f.data.get(favoriteKey)), [pageId(1), pageId(2), pageId(3)]);
  assert.deepEqual(JSON.parse(f.data.get(libraryKey)), library('read'));
  assert.deepEqual(JSON.parse(f.data.get(progressKey)), progress(5));
  assert.deepEqual(JSON.parse(f.data.get(noteKey(2))), note());
  assert.equal(f.data.get('private-session'), 'untouched');
  assert.equal(f.data.get('gallery:library:other'), JSON.stringify(library()));
});

test('明确使用备份时覆盖包含的冲突，并由当前目录重建进度信息', () => {
  const f = fixture({ [libraryKey]: library('read'), [progressKey]: progress(5), [favoriteKey]: [pageId(1)], [noteKey(2)]: note() });
  const backup = sample();
  backup.notes[0].note = '';
  const plan = planReadingImport(backup, f.storage, { mode: 'use-backup', catalog });
  for (const type of ['library', 'progress', 'notes']) assert.equal(plan.counts[type].updated, 1);
  assert.equal(applyReadingImport(plan, f.storage).ok, true);
  assert.deepEqual(JSON.parse(f.data.get(progressKey)), { url: '/' + chapter + '/', title: '当前章节', series: '当前作品', issue: '当前期', n: 3, ts: 10 });
  assert.deepEqual(JSON.parse(f.data.get(noteKey(2))), note('', 10));
  assert.deepEqual(JSON.parse(f.data.get(favoriteKey)), [pageId(1), pageId(2), pageId(3)]);
  assert.throws(() => planReadingImport(backup, f.storage, { mode: 'replace-all' }));
});

test('空备份或相同记录不会清空、重写任何已存数据', () => {
  const f = fixture({ [libraryKey]: library(), [noteKey(2)]: note(), 'private-session': 'untouched' });
  const before = new Map(f.data);
  const zero = planReadingImport({ ...empty(), bookmarks: [{ chapterKey: chapter, pages: [] }] }, f.storage, { mode: 'use-backup' });
  assert.equal(zero.changes, 0);
  assert.equal(applyReadingImport(zero, f.storage).ok, true);
  assert.deepEqual(f.data, before);
  const same = planReadingImport(exportReadingBackup(f.storage).backup, f.storage, { mode: 'use-backup' });
  assert.equal(same.changes, 0);
  assert.equal(same.counts.library.same, 1);
  assert.equal(same.counts.notes.same, 1);
  assert.equal(applyReadingImport(same, f.storage).written, 0);
  assert.deepEqual(written(f), []);
});

test('损坏目标单独报告修复，不把孤立备注当成页收藏', () => {
  const f = fixture({ [libraryKey]: '{broken', [progressKey]: '{"url":"javascript:alert(1)"}', [favoriteKey]: 'not-json', [noteKey(2)]: { version: 99, note: 'old', updatedAt: 0 } });
  const plan = planReadingImport(sample(), f.storage, { catalog });
  assert.equal(plan.counts.library.repaired, 1);
  assert.equal(plan.counts.progress.repaired, 1);
  assert.equal(plan.counts.bookmarks.repaired, 2);
  assert.equal(plan.counts.notes.repaired, 1);
  assert.equal(applyReadingImport(plan, f.storage).ok, true);
  const orphan = fixture();
  assert.equal(applyReadingImport(planReadingImport({ ...empty(), notes: sample().notes }, orphan.storage), orphan.storage).ok, true);
  assert.equal(orphan.data.has(favoriteKey), false);
  assert.equal(orphan.data.has(noteKey(2)), true);
});

test('未知目录和越界页单独计数并保留，链接从合法章节标识重建', () => {
  const f = fixture();
  const backup = { ...empty(), library: [{ seriesId: 'old', status: 'want', updatedAt: 0 }], progress: [{ chapterKey: 'old/v/c', n: 7, ts: 1 }], bookmarks: [{ chapterKey: chapter, pages: [99] }], notes: [{ chapterKey: 'old/v/c', n: 7, note: '保留', updatedAt: 1 }] };
  const plan = planReadingImport(backup, f.storage, { catalog });
  assert.equal(plan.unmatched, 4);
  assert.equal(applyReadingImport(plan, f.storage).ok, true);
  assert.deepEqual(JSON.parse(f.data.get('gallery:progress:old/v/c')), { url: '/old/v/c/', title: 'c', series: 'old', issue: 'v', n: 7, ts: 1 });
  assert.deepEqual(exportReadingBackup(f.storage).counts, { library: 1, progress: 1, bookmarks: 1, notes: 1 });
});

test('预览后数据变化时不写入，计划不能重复使用或伪造写入', () => {
  const f = fixture();
  const plan = planReadingImport(sample(), f.storage);
  f.data.set(libraryKey, JSON.stringify(library('read', 200)));
  assert.deepEqual(applyReadingImport(plan, f.storage), { ok: false, reason: 'changed', rolledBack: true, written: 0, restored: 0 });
  assert.deepEqual(written(f), []);
  assert.throws(() => applyReadingImport(plan, f.storage), /失效/);
  assert.throws(() => applyReadingImport({ operations: [{ key: 'private-session', after: 'bad' }] }, f.storage), /失效/);
  const other = fixture();
  assert.equal(applyReadingImport(planReadingImport(sample(), f.storage), other.storage).ok, false);
  assert.deepEqual(written(other), []);
});

test('修改公开预览字段不能改变私有写入计划', () => {
  const f = fixture({ 'private-session': 'safe' });
  const plan = planReadingImport(sample(), f.storage, { catalog });
  plan.changes = 0;
  plan.writes = [{ key: 'private-session', before: 'safe', after: 'bad' }];
  assert.equal(applyReadingImport(plan, f.storage).ok, true);
  assert.equal(f.data.get('private-session'), 'safe');
  assert.equal(JSON.parse(f.data.get(libraryKey)).status, 'reading');
});

test('后续写入失败时逆序回滚，原记录和无关键原样保留', () => {
  const f = fixture({ [libraryKey]: library('read'), 'private-session': 'safe' });
  const before = new Map(f.data);
  const plan = planReadingImport(sample(), f.storage, { mode: 'use-backup', catalog });
  f.setHook = () => { if (f.writes === 3) throw new Error('quota exceeded'); };
  assert.deepEqual(applyReadingImport(plan, f.storage), { ok: false, reason: 'storage', rolledBack: true, written: 2, restored: 2 });
  assert.deepEqual(f.data, before);
  assert.deepEqual(written(f).slice(-2), [['remove', progressKey], ['set', libraryKey]]);
});

test('回滚受限时明确报告不完全恢复，不把部分导入当作成功', () => {
  const f = fixture();
  const plan = planReadingImport(sample(), f.storage);
  f.setHook = () => { if (f.writes === 2) throw new Error('quota exceeded'); };
  f.removeHook = () => { throw new Error('remove denied'); };
  const result = applyReadingImport(plan, f.storage);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(result.written, 1);
  assert.equal(f.data.has(libraryKey), true);
  assert.equal(f.data.has(progressKey), false);
});

test('回滚不覆盖另一窗口后来保存的值，写入前的竞争也会中止', () => {
  const f = fixture();
  const plan = planReadingImport(sample(), f.storage);
  const external = JSON.stringify(library('read', 999));
  f.setHook = () => { if (f.writes === 2) { f.data.set(libraryKey, external); throw new Error('quota exceeded'); } };
  const result = applyReadingImport(plan, f.storage);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(f.data.get(libraryKey), external);
  const race = fixture();
  const next = planReadingImport(sample(), race.storage);
  race.getHook = (key) => { if (key === progressKey && race.data.has(libraryKey)) race.data.set(progressKey, JSON.stringify(progress(6, 999))); };
  const changed = applyReadingImport(next, race.storage);
  assert.equal(changed.reason, 'changed');
  assert.equal(changed.rolledBack, true);
  assert.equal(race.data.has(libraryKey), false);
  assert.equal(JSON.parse(race.data.get(progressKey)).n, 6);
});

test('写后检测到外部修改时保护外部值，回滚其余本次记录', () => {
  const f = fixture();
  const plan = planReadingImport(sample(), f.storage);
  f.setHook = () => { if (f.writes === 4) f.data.set(libraryKey, JSON.stringify(library('read', 999))); };
  const result = applyReadingImport(plan, f.storage);
  assert.equal(result.reason, 'changed');
  assert.equal(result.rolledBack, false);
  assert.equal(result.written, 4);
  assert.equal(result.restored, 3);
  assert.deepEqual([...f.data.keys()], [libraryKey]);
  assert.equal(JSON.parse(f.data.get(libraryKey)).updatedAt, 999);
});

test('写后复核未写入的依赖，避免另一窗口取消收藏后仍保存导入备注', () => {
  const f = fixture({ [favoriteKey]: [pageId(2)] });
  const backup = { ...empty(), bookmarks: [{ chapterKey: chapter, pages: [2] }], notes: [{ chapterKey: chapter, n: 2, note: '新备注', updatedAt: 1 }] };
  const plan = planReadingImport(backup, f.storage);
  f.setHook = () => { f.data.delete(favoriteKey); };
  const result = applyReadingImport(plan, f.storage);
  assert.equal(result.reason, 'changed');
  assert.equal(result.rolledBack, true);
  assert.equal(f.data.has(favoriteKey), false);
  assert.equal(f.data.has(noteKey(2)), false);
});

test('读取失败不会开始导入，写入抛错但结果不确定时仍尝试恢复', () => {
  const denied = fixture();
  const plan = planReadingImport(sample(), denied.storage);
  denied.getHook = () => { throw new Error('read denied'); };
  assert.deepEqual(applyReadingImport(plan, denied.storage), { ok: false, reason: 'storage', rolledBack: true, written: 0, restored: 0 });
  assert.deepEqual(written(denied), []);
  const uncertain = fixture();
  const next = planReadingImport(sample(), uncertain.storage);
  uncertain.setHook = (key, raw) => { uncertain.data.set(key, raw); throw new Error('unknown result'); };
  const result = applyReadingImport(next, uncertain.storage);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(uncertain.data.size, 0);
});
