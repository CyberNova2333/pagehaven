// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
export const PROGRESS_PREFIX = 'gallery:progress:';

// 旧记录的键和 URL 可能不同。调用方决定读哪些键，链接身份始终与当前目录精确匹配。
export function parseProgressRecord(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value?.url !== 'string') return null;
  return {
    url: value.url,
    n: Number.isSafeInteger(value.n) && value.n > 0 ? value.n : null,
    ts: Number.isFinite(value.ts) && value.ts >= 0 ? value.ts : 0,
  };
}

// 保留“记录存在但页码无效”。续读从第一页打开，目录只把有效页码标为读过。
export function progressForChapter(record, chapter) {
  if (!record || !chapter || record.url !== chapter.url) return null;
  const pages = Array.isArray(chapter.pages) ? chapter.pages.length : chapter.pages;
  return { n: record.n === null ? null : Math.min(pages, record.n), ts: record.ts };
}
