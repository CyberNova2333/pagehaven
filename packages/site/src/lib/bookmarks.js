// 页码收藏沿用增强阅读器的旧键；备注独立保存，普通与增强阅读共用同一份状态。
export const FAVORITES_PREFIX = 'gallery:favorites:';
export const NOTE_PREFIX = 'gallery:bookmark-note:';
export const MAX_NOTE_LENGTH = 200;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const validChapter = (key) => typeof key === 'string' && key.split('/').length === 3
  && key.split('/').every((part) => ID.test(part));
const validTotal = (total) => Number.isSafeInteger(total) && total > 0;
const validPage = (n, total) => Number.isSafeInteger(n) && n > 0 && n <= total;
const pageId = (key, n) => `${key}/p${n}`;

function pagesFromIds(ids, key, total) {
  if (!Array.isArray(ids)) return new Set();
  const prefix = `${key}/p`;
  return new Set(ids.flatMap((id) => {
    if (typeof id !== 'string' || !id.startsWith(prefix)) return [];
    const n = Number(id.slice(prefix.length));
    return validPage(n, total) && id === pageId(key, n) ? [n] : [];
  }));
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function parseNote(raw) {
  const note = parseJson(raw);
  if (!note || note.version !== 1 || typeof note.note !== 'string' || note.note.length > MAX_NOTE_LENGTH
    || !Number.isSafeInteger(note.updatedAt) || note.updatedAt < 0) return { note: '', updatedAt: 0 };
  return { note: note.note, updatedAt: note.updatedAt };
}

/** 失败修改按页保留在本页，重试时与最新持久收藏合并，避免覆盖别的标签页新增的页。 */
export function createBookmarkStore({ getStorage = () => window.localStorage, now = Date.now } = {}) {
  const pendingPages = new Map();
  const pendingNotes = new Map();
  const lastKnown = new Map();
  const subscribers = new Set();
  let limited = false;

  function readRaw(key, operation) {
    try {
      const raw = getStorage().getItem(key);
      lastKnown.set(key, raw);
      return raw;
    } catch {
      limited = true;
      if (operation) operation.readFailed = true;
      return lastKnown.get(key) ?? null;
    }
  }
  function pages(key, total, operation) {
    const values = pagesFromIds(parseJson(readRaw(FAVORITES_PREFIX + key, operation)), key, total);
    for (const [n, present] of pendingPages.get(key) ?? []) {
      if (!validPage(n, total)) continue;
      if (present) values.add(n);
      else values.delete(n);
    }
    return values;
  }
  function validate(key, total, n, checkPage = false) {
    if (!validChapter(key) || !validTotal(total) || (checkPage && !validPage(n, total))) throw new TypeError('书签章节或页码无效');
  }
  function writeRaw(key, raw, temporary) {
    if (!temporary) {
      try {
        const storage = getStorage();
        if (raw === null) storage.removeItem(key);
        else storage.setItem(key, raw);
        lastKnown.set(key, raw);
        return true;
      } catch { limited = true; }
    }
    return false;
  }
  function commit(key, previous, desired, notes, operation, touched = new Map()) {
    const changes = pendingPages.get(key) ?? new Map();
    for (const n of previous) if (!desired.has(n)) changes.set(n, false);
    for (const n of desired) if (!previous.has(n)) changes.set(n, true);
    for (const [n, present] of touched) changes.set(n, present);
    pendingPages.set(key, changes);
    const ids = [...desired].sort((a, b) => a - b).map((n) => pageId(key, n));
    let persisted = writeRaw(FAVORITES_PREFIX + key, JSON.stringify(ids), operation.readFailed);
    if (persisted) pendingPages.delete(key);
    for (const [noteKey, raw] of notes) {
      const saved = writeRaw(noteKey, raw, operation.readFailed);
      if (saved) pendingNotes.delete(noteKey);
      else pendingNotes.set(noteKey, raw);
      persisted = saved && persisted;
    }
    for (const notify of [...subscribers]) {
      try { notify({ chapterKey: key }); } catch { /* 一个视图失效不阻断其他视图与保存结果。 */ }
    }
    return { persisted };
  }
  function removedNotes(key, previous, desired, operation) {
    const notes = new Map();
    for (const n of previous) {
      if (desired.has(n)) continue;
      const noteKey = NOTE_PREFIX + pageId(key, n);
      if (readRaw(noteKey, operation) !== null || pendingNotes.has(noteKey)) notes.set(noteKey, null);
    }
    return notes;
  }

  return {
    get limited() { return limited; },
    list(key, total) {
      if (!validChapter(key) || !validTotal(total)) return [];
      return [...pages(key, total)].sort((a, b) => a - b).map((n) => {
        const noteKey = NOTE_PREFIX + pageId(key, n);
        const raw = pendingNotes.has(noteKey) ? pendingNotes.get(noteKey) : readRaw(noteKey);
        return { n, ...parseNote(raw) };
      });
    },
    set(key, total, n, note = '') {
      validate(key, total, n, true);
      if (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH) throw new TypeError(`书签备注最多 ${MAX_NOTE_LENGTH} 个字符`);
      const updatedAt = now();
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new TypeError('书签更新时间无效');
      const operation = { readFailed: false };
      const previous = pages(key, total, operation);
      const desired = new Set(previous).add(n);
      return commit(key, previous, desired,
        new Map([[NOTE_PREFIX + pageId(key, n), JSON.stringify({ version: 1, note, updatedAt })]]), operation, new Map([[n, true]]));
    },
    remove(key, total, n) {
      validate(key, total, n, true);
      const operation = { readFailed: false };
      const previous = pages(key, total, operation);
      const desired = new Set(previous);
      desired.delete(n);
      const notes = removedNotes(key, new Set([...previous, n]), desired, operation);
      return commit(key, previous, desired, notes, operation, new Map([[n, false]]));
    },
    replace(key, total, ids) {
      validate(key, total);
      if (!Array.isArray(ids)) throw new TypeError('书签列表必须是数组');
      const operation = { readFailed: false };
      const previous = pages(key, total, operation);
      const desired = pagesFromIds(ids, key, total);
      return commit(key, previous, desired, removedNotes(key, previous, desired, operation), operation);
    },
    subscribe(notify) {
      if (typeof notify !== 'function') throw new TypeError('书签订阅必须是函数');
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
  };
}

/** 同一个阅读页面的两个阅读器共用内存回退与变更通知。 */
export function getReaderBookmarkStore(reader) {
  if (!reader.galleryBookmarkStore) {
    reader.galleryBookmarkStore = createBookmarkStore({ getStorage: () => reader.ownerDocument.defaultView.localStorage });
  }
  return reader.galleryBookmarkStore;
}
