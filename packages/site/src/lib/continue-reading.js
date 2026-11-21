// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { createStorageRefresh } from './storage-refresh.js';
import { parseProgressRecord, progressForChapter, PROGRESS_PREFIX } from './reading-progress.js';

// 按记录里的完整 URL 匹配，兼容旧存储键。链接、标题和页数只取当前目录。
function readProgress(win, catalog) {
  const records = [];
  try {
    const storage = win.localStorage;
    const count = storage.length;
    for (let i = 0; i < count; i++) {
      try {
        const key = storage.key(i);
        if (!key?.startsWith(PROGRESS_PREFIX)) continue;
        const record = parseProgressRecord(storage.getItem(key));
        const chapter = catalog.get(record?.url);
        const progress = progressForChapter(record, chapter);
        if (progress) records.push({ chapter, n: progress.n ?? 1, ts: progress.ts });
      } catch { /* 单条损坏或读取失败不影响后续记录。 */ }
    }
  } catch { /* 浏览器禁止访问存储时显示静态默认入口。 */ }
  return records;
}

function watchProgress(win, chapters, controls, render) {
  if (!chapters.length) return;
  const catalog = new Map(chapters.map((chapter) => [chapter.url, chapter]));
  const pending = createStorageRefresh(win, refresh);
  function refresh() {
    pending.cancel();
    render(readProgress(win, catalog));
  }
  win.addEventListener('storage', (event) => {
    if (!win.document.hidden && (event.key === null || event.key?.startsWith(PROGRESS_PREFIX))) pending.request();
  });
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.hidden) pending.cancel();
    else refresh();
  });
  win.addEventListener('pageshow', (event) => { if (event.persisted) refresh(); });
  // 同一窗口内也可能在合并刷新完成前点链接。让浏览器按最新 href 执行原生导航。
  controls.addEventListener('click', refresh, true);
  controls.addEventListener('auxclick', refresh, true);
  refresh();
}

export function mountSeriesReading(win) {
  const doc = win.document;
  const link = doc.getElementById('start-reading');
  if (!link) return;
  const chapters = JSON.parse(doc.getElementById('series-chapters').textContent);
  const first = link.getAttribute('href');
  const label = link.textContent;
  watchProgress(win, chapters, link, (records) => {
    let best = null;
    for (const entry of records) if (!best || entry.ts > best.ts) best = entry;
    const href = best ? best.chapter.url + '#p' + best.n : first;
    const text = best ? '继续阅读：' + best.chapter.title + ' →' : label;
    if (link.getAttribute('href') !== href) link.href = href;
    if (link.textContent !== text) link.textContent = text;
  });
}

export function mountHomeReading(win) {
  const doc = win.document;
  const chapters = JSON.parse(doc.getElementById('random-pool').textContent);
  doc.getElementById('random-btn')?.addEventListener('click', () => {
    if (chapters.length) win.location.href = chapters[Math.floor(Math.random() * chapters.length)].url;
  });

  const list = doc.getElementById('continue-list');
  const section = doc.getElementById('continue');
  let rows = new Map();
  watchProgress(win, chapters, list, (records) => {
    const latest = new Map();
    for (const entry of records) {
      const prev = latest.get(entry.chapter.url);
      if (!prev || entry.ts > prev.ts) latest.set(entry.chapter.url, entry);
    }
    // 即使点下时记录刚被清除或挤出前三，原链接也不会用过期页码覆盖阅读器进度。
    for (const [url, row] of rows) {
      const entry = latest.get(url);
      const href = entry ? url + '#p' + entry.n : url;
      if (row.firstElementChild.getAttribute('href') !== href) row.firstElementChild.href = href;
    }

    const recent = [...latest.values()].sort((a, b) => b.ts - a.ts).slice(0, 3);
    const next = new Map();
    for (const { chapter, n } of recent) {
      let row = rows.get(chapter.url);
      if (!row) {
        row = doc.createElement('li');
        const link = doc.createElement('a');
        link.href = chapter.url + '#p' + n;
        link.textContent = chapter.title;
        const meta = doc.createElement('small');
        meta.textContent = [chapter.series, chapter.issue].filter(Boolean).join(' · ');
        row.append(link, meta);
      }
      next.set(chapter.url, row);
    }
    const children = [...next.values()];
    if (list.children.length !== children.length || children.some((row, i) => row !== list.children[i])) {
      const focused = doc.activeElement;
      list.replaceChildren(...children);
      if (focused && list.contains(focused) && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    section.hidden = !children.length;
    rows = next;
  });
}
