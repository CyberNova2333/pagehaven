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

function pagesFromIds(ids, key, total = Number.MAX_SAFE_INTEGER) {
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
  // 一个失败操作保留同页成员与备注的上下文，不能把两个键拆成无关的待写字节。
  const pending = new Map();
  const lastKnown = new Map();
  const subscribers = new Set();
  let limited = false;

  function readRaw(key, operation) {
    try {
      const raw = getStorage().getItem(key);
      lastKnown.set(key, raw);
      operation?.snapshots.set(key, { raw, known: true });
      return raw;
    } catch {
      limited = true;
      if (operation) operation.readFailed = true;
      const raw = lastKnown.get(key) ?? null;
      operation?.snapshots.set(key, { raw, known: lastKnown.has(key) });
      return raw;
    }
  }
  function pages(key, operation) {
    const values = pagesFromIds(parseJson(readRaw(FAVORITES_PREFIX + key, operation)), key);
    for (const [n, change] of pending.get(key) ?? []) {
      if (change.present) values.add(n);
      else values.delete(n);
    }
    return values;
  }
  function validate(key, total, n, checkPage = false) {
    if (!validChapter(key) || !validTotal(total) || (checkPage && !validPage(n, total))) throw new TypeError('书签章节或页码无效');
  }
  function writeRaw(key, raw) {
    try {
      const storage = getStorage();
      if (raw === null) storage.removeItem(key);
      else storage.setItem(key, raw);
      lastKnown.set(key, raw);
      return true;
    } catch { limited = true; }
    return false;
  }
  const operation = () => ({ readFailed: false, snapshots: new Map() });
  const hasConflict = () => [...pending.values()].some((changes) => [...changes.values()].some((change) => change.conflict));
  function sameContext(change, present, note) {
    const sameMember = (change.memberKnown ? present === change.expectedPresent : !present) || present === change.present;
    const sameNote = (change.noteKnown ? note === change.expectedNote : note === null)
      || (change.note !== undefined && note === change.note);
    return sameMember && sameNote;
  }
  function flush(key) {
    const changes = pending.get(key);
    if (!changes) return;
    const read = operation();
    const savedPages = pagesFromIds(parseJson(readRaw(FAVORITES_PREFIX + key, read)), key);
    const savedNotes = new Map([...changes.keys()].map((n) => [n, readRaw(NOTE_PREFIX + pageId(key, n), read)]));
    if (read.readFailed) { notify(key); return; }
    const ready = new Map();
    for (const [n, change] of changes) {
      const present = savedPages.has(n);
      const note = savedNotes.get(n);
      const memberReady = present === change.present;
      const noteReady = change.note === undefined || note === change.note;
      if (memberReady && noteReady) { changes.delete(n); continue; }
      change.conflict = !sameContext(change, present, note);
      if (!change.conflict) ready.set(n, change);
    }
    const desired = new Set(savedPages);
    for (const [n, change] of ready) { if (change.present) desired.add(n); else desired.delete(n); }
    const memberChanges = [...ready].some(([n, change]) => savedPages.has(n) !== change.present);
    const membersSaved = !memberChanges || writeRaw(FAVORITES_PREFIX + key,
      JSON.stringify([...desired].sort((a, b) => a - b).map((n) => pageId(key, n))));
    for (const [n, change] of ready) {
      if (membersSaved) {
        change.expectedPresent = change.present;
        change.memberKnown = true;
      }
      const memberReady = membersSaved || savedPages.has(n) === change.present;
      let noteReady = change.note === undefined || savedNotes.get(n) === change.note;
      // 成员还没保存时不提前修改备注，避免新增孤立备注或提前删除仍收藏页的备注。
      if (memberReady && !noteReady) {
        noteReady = writeRaw(NOTE_PREFIX + pageId(key, n), change.note);
        if (noteReady) { change.expectedNote = change.note; change.noteKnown = true; }
      }
      if (memberReady && noteReady) changes.delete(n);
    }
    if (!changes.size) pending.delete(key);
    notify(key);
  }
  function commit(key, previous, desired, notes, read, touched = new Map()) {
    const explicit = new Map();
    const changes = pending.get(key) ?? new Map();
    for (const n of previous) if (!desired.has(n)) explicit.set(n, false);
    for (const n of desired) if (!previous.has(n)) explicit.set(n, true);
    for (const [n, present] of touched) explicit.set(n, present);
    for (const noteKey of notes.keys()) {
      const n = Number(noteKey.slice(noteKey.lastIndexOf('/p') + 2));
      explicit.set(n, desired.has(n));
    }
    const members = read.snapshots.get(FAVORITES_PREFIX + key);
    const savedPages = pagesFromIds(parseJson(members.raw), key);
    for (const [n, present] of explicit) {
      const noteKey = NOTE_PREFIX + pageId(key, n);
      if (!read.snapshots.has(noteKey)) readRaw(noteKey, read);
      const note = read.snapshots.get(noteKey);
      const existing = changes.get(n);
      if (present && !notes.has(noteKey) && existing) {
        // 增强阅读器的收藏增量不包含备注，不能把另一个视图待保存的备注清空。
        // 对已有冲突也沿用旧上下文；明确编辑备注或放弃后重载才能开始新意图。
        if (existing.present || !sameContext(existing, savedPages.has(n), note.raw)) continue;
      }
      // 明确再次操作同一页视为新的意图；其他页的失败操作仍用原上下文核对。
      changes.set(n, { present, note: notes.has(noteKey) ? notes.get(noteKey) : present ? undefined : null,
        expectedPresent: savedPages.has(n), memberKnown: members.known,
        expectedNote: note.raw, noteKnown: note.known, conflict: false });
    }
    if (changes.size) pending.set(key, changes);
    if (read.readFailed) notify(key);
    else flush(key);
    const remaining = pending.get(key);
    const persisted = [...explicit.keys()].every((n) => !remaining?.has(n));
    return [...explicit.keys()].some((n) => remaining?.get(n)?.conflict) ? { persisted, conflict: true } : { persisted };
  }
  function removedNotes(key, previous, desired, operation) {
    const notes = new Map();
    for (const n of previous) {
      if (desired.has(n)) continue;
      const noteKey = NOTE_PREFIX + pageId(key, n);
      if (readRaw(noteKey, operation) !== null || pending.get(key)?.has(n)) notes.set(noteKey, null);
    }
    return notes;
  }
  function notify(key) {
    for (const subscriber of [...subscribers]) {
      try { subscriber({ chapterKey: key }); } catch { /* 一个视图失效不阻断其他视图与保存结果。 */ }
    }
  }
  function noteAt(key, n) {
    const noteKey = NOTE_PREFIX + pageId(key, n);
    const change = pending.get(key)?.get(n);
    return { n, ...parseNote(change?.note !== undefined ? change.note : readRaw(noteKey)) };
  }

  return {
    get limited() { return limited; },
    get hasPending() { return pending.size > 0; },
    get hasConflict() { return hasConflict(); },
    ids(key, total) {
      if (!validChapter(key) || !validTotal(total)) return [];
      return [...pages(key)].filter((n) => validPage(n, total)).sort((a, b) => a - b).map((n) => pageId(key, n));
    },
    get(key, total, n) {
      if (!validChapter(key) || !validTotal(total) || !validPage(n, total)) return null;
      return pages(key).has(n) ? noteAt(key, n) : null;
    },
    list(key, total) {
      if (!validChapter(key) || !validTotal(total)) return [];
      return [...pages(key)].filter((n) => validPage(n, total)).sort((a, b) => a - b).map((n) => noteAt(key, n));
    },
    set(key, total, n, note = '') {
      validate(key, total, n, true);
      if (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH) throw new TypeError(`书签备注最多 ${MAX_NOTE_LENGTH} 个字符`);
      const updatedAt = now();
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new TypeError('书签更新时间无效');
      const read = operation();
      const previous = pages(key, read);
      const desired = new Set(previous).add(n);
      return commit(key, previous, desired,
        new Map([[NOTE_PREFIX + pageId(key, n), JSON.stringify({ version: 1, note, updatedAt })]]), read, new Map([[n, true]]));
    },
    remove(key, total, n) {
      validate(key, total, n, true);
      const read = operation();
      const previous = pages(key, read);
      const desired = new Set(previous);
      desired.delete(n);
      const notes = removedNotes(key, new Set([...previous, n]), desired, read);
      return commit(key, previous, desired, notes, read, new Map([[n, false]]));
    },
    replace(key, total, ids) {
      validate(key, total);
      if (!Array.isArray(ids)) throw new TypeError('书签列表必须是数组');
      const read = operation();
      const previous = pages(key, read);
      // 全量替换仅针对当前可见页，合法旧页仍供备份和后续内容恢复。
      const desired = new Set([...previous].filter((n) => n > total));
      for (const n of pagesFromIds(ids, key, total)) desired.add(n);
      return commit(key, previous, desired, removedNotes(key, previous, desired, read), read);
    },
    updateFavorites(key, total, beforeIds, afterIds) {
      validate(key, total);
      if (!Array.isArray(beforeIds) || !Array.isArray(afterIds)) throw new TypeError('书签列表必须是数组');
      const before = pagesFromIds(beforeIds, key, total);
      const after = pagesFromIds(afterIds, key, total);
      const touched = new Map();
      for (const n of before) if (!after.has(n)) touched.set(n, false);
      for (const n of after) if (!before.has(n)) touched.set(n, true);
      const read = operation();
      const previous = pages(key, read);
      const desired = new Set(previous);
      for (const [n, present] of touched) { if (present) desired.add(n); else desired.delete(n); }
      const removed = new Set([...touched].filter(([, present]) => !present).map(([n]) => n));
      const notes = removedNotes(key, new Set([...previous, ...removed]), desired, read);
      return commit(key, previous, desired, notes, read, touched);
    },
    retryPending() {
      for (const key of [...pending.keys()]) flush(key);
      const persisted = pending.size === 0;
      return hasConflict() ? { persisted, conflict: true } : { persisted };
    },
    discardPending() {
      const chapters = [...pending.keys()];
      pending.clear();
      for (const key of chapters) notify(key);
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
