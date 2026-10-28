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
 * 只根据当前目录恢复既有进度，标题与链接始终来自目录；坏记录不阻断其他章节。
 * pages 接受生成数据的页数组，或书架精简目录的页数。
 */
export function latestSeriesProgress(series, storage) {
  if (!isId(series?.id) || !Array.isArray(series.issues)) return null;
  let best = null;
  for (const issue of series.issues) {
    if (!Array.isArray(issue?.chapters)) continue;
    for (const chapter of issue.chapters) {
      const parts = typeof chapter?.key === 'string' ? chapter.key.split('/') : [];
      const pages = Array.isArray(chapter?.pages) ? chapter.pages.length : chapter?.pages;
      if (parts.length !== 3 || !parts.every(isId) || parts[0] !== series.id
        || (issue.id !== undefined && issue.id !== parts[1])
        || (chapter.id !== undefined && chapter.id !== parts[2])
        || chapter.url !== `/${chapter.key}/` || !Number.isSafeInteger(pages) || pages < 1) continue;
      try {
        const value = JSON.parse(storage.getItem(`gallery:progress:${chapter.key}`));
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.url !== chapter.url) continue;
        const n = Number.isSafeInteger(value.n) ? Math.max(1, Math.min(pages, value.n)) : 1;
        const ts = Number.isFinite(value.ts) && value.ts >= 0 ? value.ts : 0;
        if (!best || ts >= best.ts) best = { chapter, n, ts };
      } catch { /* 单条读取失败或坏 JSON 不影响后面的有效进度。 */ }
    }
  }
  return best;
}
