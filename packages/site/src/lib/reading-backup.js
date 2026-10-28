// 个人数据通过文件在浏览器间迁移；只读取和修改已登记的四类存储键。
import { LIBRARY_PREFIX } from './library.js';
import { FAVORITES_PREFIX, NOTE_PREFIX, MAX_NOTE_LENGTH } from './bookmarks.js';

export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export const MAX_BACKUP_RECORDS = 20000;
const FORMAT = 'pagehaven-reading-backup';
const PROGRESS_PREFIX = 'gallery:progress:';
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TYPES = ['library', 'progress', 'bookmarks', 'notes'];
const plans = new WeakMap();
const isId = (value) => typeof value === 'string' && ID.test(value);
const isChapter = (value) => typeof value === 'string' && value.split('/').length === 3 && value.split('/').every(isId);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const json = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
const countsOf = (backup) => ({ library: backup.library.length, progress: backup.progress.length, bookmarks: backup.bookmarks.reduce((sum, entry) => sum + entry.pages.length, 0), notes: backup.notes.length });
const totalOf = (counts) => Object.values(counts).reduce((sum, value) => sum + value, 0);
const limited = () => { throw new Error('备份超过 5 MiB 或 20,000 条记录限制'); };

function exact(value, fields) {
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new Error('备份字段不完整或包含不支持的字段');
}
function byteLimit(text) {
  if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) limited();
}
function unique(seen, key) {
  if (seen.has(key)) throw new Error('备份中存在重复的记录标识');
  seen.add(key);
}
function checkRecord(condition) {
  if (!condition) throw new Error('备份包含无效的标识、页码、时间或备注');
}

function validateBackup(value) {
  exact(value, ['format', 'version', 'createdAt', ...TYPES]);
  if (value.format !== FORMAT || value.version !== 1) throw new Error('不是受支持的阅读数据备份或版本');
  checkRecord(timestamp(value.createdAt));
  for (const type of TYPES) {
    if (!Array.isArray(value[type])) throw new Error('备份记录必须是数组');
    if (value[type].length > MAX_BACKUP_RECORDS) limited();
  }
  const backup = { format: FORMAT, version: 1, createdAt: value.createdAt, library: [], progress: [], bookmarks: [], notes: [] };
  const seen = Object.fromEntries(TYPES.map((type) => [type, new Set()]));
  for (const entry of value.library) {
    exact(entry, ['seriesId', 'status', 'updatedAt']);
    checkRecord(isId(entry.seriesId) && ['want', 'reading', 'read'].includes(entry.status) && timestamp(entry.updatedAt));
    unique(seen.library, entry.seriesId);
    backup.library.push({ seriesId: entry.seriesId, status: entry.status, updatedAt: entry.updatedAt });
  }
  for (const entry of value.progress) {
    exact(entry, ['chapterKey', 'n', 'ts']);
    checkRecord(isChapter(entry.chapterKey) && positive(entry.n) && timestamp(entry.ts));
    unique(seen.progress, entry.chapterKey);
    backup.progress.push({ chapterKey: entry.chapterKey, n: entry.n, ts: entry.ts });
  }
  let bookmarkCount = 0;
  for (const entry of value.bookmarks) {
    exact(entry, ['chapterKey', 'pages']);
    checkRecord(isChapter(entry.chapterKey) && Array.isArray(entry.pages));
    if (entry.pages.length > MAX_BACKUP_RECORDS || bookmarkCount + entry.pages.length > MAX_BACKUP_RECORDS) limited();
    bookmarkCount += entry.pages.length;
    unique(seen.bookmarks, entry.chapterKey);
    const pages = new Set();
    for (const n of entry.pages) { checkRecord(positive(n)); unique(pages, n); }
    backup.bookmarks.push({ chapterKey: entry.chapterKey, pages: [...pages].sort((a, b) => a - b) });
  }
  for (const entry of value.notes) {
    exact(entry, ['chapterKey', 'n', 'note', 'updatedAt']);
    checkRecord(isChapter(entry.chapterKey) && positive(entry.n) && typeof entry.note === 'string' && entry.note.length <= MAX_NOTE_LENGTH && timestamp(entry.updatedAt));
    unique(seen.notes, `${entry.chapterKey}/p${entry.n}`);
    backup.notes.push({ chapterKey: entry.chapterKey, n: entry.n, note: entry.note, updatedAt: entry.updatedAt });
  }
  if (totalOf(countsOf(backup)) > MAX_BACKUP_RECORDS) limited();
  byteLimit(JSON.stringify(backup));
  return backup;
}

/** 读取 JSON 文件，不接受任意存储键、链接或可执行配置。 */
export function parseReadingBackup(text) {
  if (typeof text !== 'string') throw new Error('请选择 JSON 格式的阅读数据备份');
  byteLimit(text);
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('备份不是有效的 JSON 文件'); }
  return validateBackup(value);
}

function libraryValue(value) {
  return object(value) && value.version === 1 && ['want', 'reading', 'read'].includes(value.status) && timestamp(value.updatedAt)
    ? { version: 1, status: value.status, updatedAt: value.updatedAt } : null;
}
function noteValue(value) {
  return object(value) && value.version === 1 && typeof value.note === 'string' && value.note.length <= MAX_NOTE_LENGTH && timestamp(value.updatedAt)
    ? { version: 1, note: value.note, updatedAt: value.updatedAt } : null;
}
function progressValue(value, key) {
  return object(value) && value.url === `/${key}/` && positive(value.n) && timestamp(value.ts)
    ? { chapterKey: key, n: value.n, ts: value.ts } : null;
}
function favoriteValue(value, key) {
  const pages = new Set();
  let invalid = Array.isArray(value) ? 0 : 1;
  if (Array.isArray(value)) for (const id of value) {
    const prefix = `${key}/p`;
    const n = typeof id === 'string' && id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN;
    if (!positive(n) || id !== `${key}/p${n}` || pages.has(n)) invalid++;
    else pages.add(n);
  }
  return { pages, invalid };
}
function storageKey(key) {
  for (const [type, prefix] of [['library', LIBRARY_PREFIX], ['progress', PROGRESS_PREFIX], ['bookmarks', FAVORITES_PREFIX], ['notes', NOTE_PREFIX]]) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (type === 'library') return isId(id) ? { type, id } : { invalid: true };
    if (type !== 'notes') return isChapter(id) ? { type, id } : { invalid: true };
    const separator = id.lastIndexOf('/p');
    const chapterKey = id.slice(0, separator);
    const n = Number(id.slice(separator + 2));
    return isChapter(chapterKey) && positive(n) && id === `${chapterKey}/p${n}` ? { type, id: chapterKey, n } : { invalid: true };
  }
  return null;
}
function storageKeys(storage) {
  const length = storage.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > 100000) throw new Error('浏览器存储条目过多或无法完整读取');
  const keys = new Set();
  for (let i = 0; i < length; i++) {
    const key = storage.key(i);
    if (typeof key !== 'string') throw new Error('阅读数据正在变化，请稍后重新导出');
    if (storageKey(key)) keys.add(key);
  }
  if (storage.length !== length) throw new Error('阅读数据正在变化，请稍后重新导出');
  return [...keys].sort();
}

/** 仅导出已经持久保存的记录；读取受限或快照变化时整体失败。 */
export function exportReadingBackup(storage, { now = Date.now } = {}) {
  const backup = { format: FORMAT, version: 1, createdAt: now(), library: [], progress: [], bookmarks: [], notes: [] };
  checkRecord(timestamp(backup.createdAt));
  let skipped = 0;
  let exportedCount = 0;
  const snapshots = new Map();
  const keys = storageKeys(storage);
  for (const key of keys) {
    const kind = storageKey(key);
    if (kind.invalid) { skipped++; continue; }
    const raw = storage.getItem(key);
    snapshots.set(key, raw);
    if (raw === null) throw new Error('阅读数据正在变化，请稍后重新导出');
    const value = json(raw);
    if (kind.type === 'library') {
      const entry = libraryValue(value);
      if (entry) { backup.library.push({ seriesId: kind.id, status: entry.status, updatedAt: entry.updatedAt }); exportedCount++; } else skipped++;
    } else if (kind.type === 'progress') {
      const entry = progressValue(value, kind.id);
      if (entry) { backup.progress.push(entry); exportedCount++; } else skipped++;
    } else if (kind.type === 'notes') {
      const entry = noteValue(value);
      if (entry) { backup.notes.push({ chapterKey: kind.id, n: kind.n, note: entry.note, updatedAt: entry.updatedAt }); exportedCount++; } else skipped++;
    } else {
      const { pages, invalid } = favoriteValue(value, kind.id);
      skipped += invalid;
      exportedCount += pages.size;
      if (pages.size) backup.bookmarks.push({ chapterKey: kind.id, pages: [...pages].sort((a, b) => a - b) });
    }
    if (exportedCount > MAX_BACKUP_RECORDS) limited();
  }
  if (JSON.stringify(storageKeys(storage)) !== JSON.stringify(keys) || [...snapshots].some(([key, raw]) => storage.getItem(key) !== raw)) throw new Error('阅读数据正在变化，请稍后重新导出');
  const normalized = validateBackup(backup);
  return { backup: normalized, counts: countsOf(normalized), skipped };
}

function catalogIndex(catalog) {
  const series = new Set();
  const chapters = new Map();
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!isId(entry?.id) || !Array.isArray(entry.issues)) continue;
    series.add(entry.id);
    for (const issue of entry.issues) {
      if (!isId(issue?.id) || !Array.isArray(issue.chapters)) continue;
      for (const chapter of issue.chapters) {
        if (!isChapter(chapter?.key) || !chapter.key.startsWith(`${entry.id}/${issue.id}/`) || chapter.url !== `/${chapter.key}/`) continue;
        const pages = Array.isArray(chapter.pages) ? chapter.pages.length : chapter.pages;
        if (!positive(pages)) continue;
        chapters.set(chapter.key, { pages, title: typeof chapter.title === 'string' ? chapter.title : chapter.key.split('/')[2], series: typeof entry.title === 'string' ? entry.title : entry.id, issue: typeof issue.title === 'string' ? issue.title : issue.id });
      }
    }
  }
  return { series, chapters };
}

/** 预览不写入。缺少当前目录的合法记录仍保留，供迁移与后续内容恢复。 */
export function planReadingImport(value, storage, { mode = 'keep-existing', catalog = [] } = {}) {
  if (!['keep-existing', 'use-backup'].includes(mode)) throw new Error('请选择保留本机记录或使用备份记录');
  const backup = validateBackup(value);
  const counts = Object.fromEntries(TYPES.map((type) => [type, { added: 0, updated: 0, kept: 0, same: 0, repaired: 0 }]));
  const snapshots = new Map();
  const writes = [];
  const index = catalogIndex(catalog);
  let unmatched = 0;
  const matches = (key, n) => index.chapters.has(key) && n <= index.chapters.get(key).pages;
  const read = (key) => {
    if (!snapshots.has(key)) snapshots.set(key, storage.getItem(key));
    return snapshots.get(key);
  };
  function scalar(type, key, desired, current, same) {
    const before = read(key);
    if (current && same) { counts[type].same++; return; }
    if (current && mode === 'keep-existing') { counts[type].kept++; return; }
    const result = before === null ? 'added' : current ? 'updated' : 'repaired';
    counts[type][result]++;
    writes.push({ key, before, after: JSON.stringify(desired) });
  }
  for (const entry of backup.library) {
    const key = LIBRARY_PREFIX + entry.seriesId;
    const current = libraryValue(json(read(key)));
    const desired = { version: 1, status: entry.status, updatedAt: entry.updatedAt };
    scalar('library', key, desired, current, current && current.status === entry.status && current.updatedAt === entry.updatedAt);
    if (!index.series.has(entry.seriesId)) unmatched++;
  }
  for (const entry of backup.progress) {
    const key = PROGRESS_PREFIX + entry.chapterKey;
    const current = progressValue(json(read(key)), entry.chapterKey);
    const [series, issue, title] = entry.chapterKey.split('/');
    const metadata = index.chapters.get(entry.chapterKey) ?? { title, series, issue };
    const desired = { url: `/${entry.chapterKey}/`, title: metadata.title, series: metadata.series, issue: metadata.issue, n: entry.n, ts: entry.ts };
    scalar('progress', key, desired, current, current && current.n === entry.n && current.ts === entry.ts);
    if (!matches(entry.chapterKey, entry.n)) unmatched++;
  }
  for (const entry of backup.bookmarks) {
    if (!entry.pages.length) continue;
    const key = FAVORITES_PREFIX + entry.chapterKey;
    const before = read(key);
    const current = favoriteValue(json(before), entry.chapterKey);
    let changed = false;
    for (const n of entry.pages) {
      if (current.pages.has(n)) counts.bookmarks.same++;
      else { counts.bookmarks[before !== null && current.invalid ? 'repaired' : 'added']++; current.pages.add(n); changed = true; }
      if (!matches(entry.chapterKey, n)) unmatched++;
    }
    if (changed) writes.push({ key, before, after: JSON.stringify([...current.pages].sort((a, b) => a - b).map((n) => `${entry.chapterKey}/p${n}`)) });
  }
  for (const entry of backup.notes) {
    const key = NOTE_PREFIX + `${entry.chapterKey}/p${entry.n}`;
    const current = noteValue(json(read(key)));
    const desired = { version: 1, note: entry.note, updatedAt: entry.updatedAt };
    scalar('notes', key, desired, current, current && current.note === entry.note && current.updatedAt === entry.updatedAt);
    if (!matches(entry.chapterKey, entry.n)) unmatched++;
  }
  const plan = { counts, unmatched, changes: writes.length };
  plans.set(plan, { storage, snapshots, writes });
  return plan;
}

/** 多键存储没有事务；失败时尽力恢复，仅回滚仍由本次操作持有的值。 */
export function applyReadingImport(plan, storage) {
  const state = plans.get(plan);
  if (!state) throw new Error('导入预览已失效，请重新预览');
  plans.delete(plan);
  if (state.storage !== storage) return { ok: false, reason: 'changed', rolledBack: true, written: 0, restored: 0 };
  const touched = [];
  let written = 0;
  let reason = 'storage';
  const check = () => {
    for (const [key, raw] of state.snapshots) if (storage.getItem(key) !== raw) { reason = 'changed'; return false; }
    return true;
  };
  try {
    if (!check()) return { ok: false, reason, rolledBack: true, written: 0, restored: 0 };
    for (const operation of state.writes) {
      if (storage.getItem(operation.key) !== operation.before) { reason = 'changed'; throw new Error('changed'); }
      touched.push(operation);
      storage.setItem(operation.key, operation.after);
      written++;
    }
    const expected = new Map(state.snapshots);
    for (const operation of state.writes) expected.set(operation.key, operation.after);
    for (const [key, raw] of expected) if (storage.getItem(key) !== raw) { reason = 'changed'; throw new Error('changed'); }
    return { ok: true, written, restored: 0 };
  } catch {
    let restored = 0;
    let rolledBack = true;
    for (const operation of touched.reverse()) {
      try {
        const current = storage.getItem(operation.key);
        if (current === operation.before) continue;
        if (current !== operation.after) { rolledBack = false; continue; }
        if (operation.before === null) storage.removeItem(operation.key);
        else storage.setItem(operation.key, operation.before);
        if (storage.getItem(operation.key) === operation.before) restored++;
        else rolledBack = false;
      } catch { rolledBack = false; }
    }
    return { ok: false, reason, rolledBack, written, restored };
  }
}
