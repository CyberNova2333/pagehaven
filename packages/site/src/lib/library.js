// 个人书架只保存作品状态；现有阅读进度仍由阅读器独立维护。
export const LIBRARY_PREFIX = 'gallery:library:';
export const READING_STATUSES = [
  { value: 'want', label: '想读' },
  { value: 'reading', label: '在读' },
  { value: 'read', label: '已读' },
];

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const isId = (value) => typeof value === 'string' && ID.test(value);
const isStatus = (value) => READING_STATUSES.some((status) => status.value === value);

function parseEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !isStatus(value.status) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return null;
  return { version: 1, status: value.status, updatedAt: value.updatedAt };
}

/**
 * 每作品独立保存，写入失败时只在本页保留用户操作；访问时不清理或迁移旧数据。
 * @param {{getStorage?: () => Storage, now?: () => number}} options
 */
export function createLibraryStore({ getStorage = () => window.localStorage, now = Date.now } = {}) {
  const pending = new Map();
  let limited = false;
  const keyFor = (seriesId) => {
    if (!isId(seriesId)) throw new TypeError('作品标识无效');
    return LIBRARY_PREFIX + seriesId;
  };

  return {
    get limited() { return limited; },
    get hasPending() { return pending.size > 0; },
    retryPending() {
      for (const [seriesId, entry] of [...pending]) {
        try {
          const storage = getStorage();
          if (entry === null) storage.removeItem(keyFor(seriesId));
          else storage.setItem(keyFor(seriesId), JSON.stringify(entry));
          pending.delete(seriesId);
        } catch { limited = true; }
      }
      return { persisted: pending.size === 0 };
    },
    discardPending() { pending.clear(); },
    read(seriesId) {
      if (!isId(seriesId)) return null;
      if (pending.has(seriesId)) {
        const entry = pending.get(seriesId);
        return entry ? { ...entry } : null;
      }
      let raw;
      try { raw = getStorage().getItem(keyFor(seriesId)); }
      catch { limited = true; return null; }
      try { return parseEntry(JSON.parse(raw)); }
      catch { return null; }
    },
    set(seriesId, status) {
      const key = keyFor(seriesId);
      if (!isStatus(status)) throw new TypeError('阅读状态无效');
      const updatedAt = now();
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new TypeError('书架更新时间无效');
      const entry = { version: 1, status, updatedAt };
      try {
        getStorage().setItem(key, JSON.stringify(entry));
        pending.delete(seriesId);
        return { persisted: true };
      } catch {
        limited = true;
        pending.set(seriesId, entry);
        return { persisted: false };
      }
    },
    remove(seriesId) {
      const key = keyFor(seriesId);
      try {
        getStorage().removeItem(key);
        pending.delete(seriesId);
        return { persisted: true };
      } catch {
        limited = true;
        pending.set(seriesId, null);
        return { persisted: false };
      }
    },
  };
}

/**
 * 一次读取当前目录中各章的进度，供最近阅读和书架恢复共用同一快照。
 * 标题与链接始终来自目录；pages 接受生成数据的页数组或精简目录的页数。
 * 坏内容跳过，读取受限单独反馈；不枚举、修改或清理浏览器存储。
 */
export function readReadingProgress(catalog, storage) {
  const rows = [];
  const latest = new Map();
  let limited = false;
  for (const series of Array.isArray(catalog) ? catalog : []) {
    if (!isId(series?.id) || !Array.isArray(series.issues)) continue;
    for (const issue of series.issues) {
      if (!Array.isArray(issue?.chapters)) continue;
      for (const chapter of issue.chapters) {
        const parts = typeof chapter?.key === 'string' ? chapter.key.split('/') : [];
        const pages = Array.isArray(chapter?.pages) ? chapter.pages.length : chapter?.pages;
        if (parts.length !== 3 || !parts.every(isId) || parts[0] !== series.id
          || (issue.id !== undefined && issue.id !== parts[1])
          || (chapter.id !== undefined && chapter.id !== parts[2])
          || chapter.url !== `/${chapter.key}/` || !Number.isSafeInteger(pages) || pages < 1) continue;
        let raw;
        try { raw = storage.getItem(`gallery:progress:${chapter.key}`); }
        catch { limited = true; continue; }
        let value;
        try { value = JSON.parse(raw); }
        catch { continue; }
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.url !== chapter.url) continue;
        const n = Number.isSafeInteger(value.n) ? Math.max(1, Math.min(pages, value.n)) : 1;
        const ts = Number.isFinite(value.ts) && value.ts >= 0 ? value.ts : 0;
        rows.push({ series, issue, chapter, n, ts });
        const best = latest.get(series.id);
        if (!best || ts >= best.ts) latest.set(series.id, { chapter, n, ts });
      }
    }
  }
  // 稳定排序让同时间记录按目录后章优先，与逐作品恢复的既有规则一致。
  rows.reverse().sort((left, right) => right.ts - left.ts);
  return { rows, latest, limited };
}

/** 保留逐作品恢复入口的输出形状与容错规则。 */
export function latestSeriesProgress(series, storage) {
  return readReadingProgress([series], storage).latest.get(series?.id) ?? null;
}
