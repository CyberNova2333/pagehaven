// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
const PAGE_SIZE = 50;

export function mountTitleSearch(doc, fetchCatalog = fetch) {
  const form = doc.getElementById('meta-form');
  const input = doc.getElementById('meta-q');
  const list = doc.getElementById('meta-results');
  const status = doc.getElementById('meta-status');
  const more = doc.getElementById('meta-more');
  let cache;
  let sequence = 0;
  let matches = [];
  let shown = 0;

  function load() {
    if (!cache) {
      cache = fetchCatalog('/index/series.json').then(async (response) => {
        if (!response.ok) throw new Error('作品目录请求失败');
        const items = await response.json();
        if (!Array.isArray(items)) throw new Error('作品目录格式无效');
        return items;
      }).catch((error) => {
        cache = null;
        throw error;
      });
    }
    return cache;
  }

  function showMore(event) {
    const firstNew = shown;
    const moveFocus = event && doc.activeElement === more;
    const batch = matches.slice(shown, shown + PAGE_SIZE);
    for (const series of batch) {
      const row = doc.createElement('li');
      const link = doc.createElement('a');
      link.href = series.url;
      link.textContent = series.title;
      const info = doc.createElement('small');
      info.textContent = [(series.authors || []).join(' / '), series.chapters + ' 话'].filter(Boolean).join(' · ');
      row.appendChild(link);
      row.appendChild(info);
      list.appendChild(row);
    }
    shown += batch.length;
    if (moveFocus && batch.length) list.children[firstNew].firstElementChild.focus();
    more.hidden = shown >= matches.length;
    status.textContent = matches.length > PAGE_SIZE ? `已显示 ${shown} / ${matches.length} 部作品` : '';
  }

  async function filter() {
    const request = ++sequence;
    const keyword = input.value.trim().toLowerCase();
    more.hidden = true;
    status.textContent = '正在加载作品目录……';
    try {
      const items = await load();
      if (request !== sequence) return;
      matches = keyword ? items.filter((series) => [series.title, series.description].concat(
        series.altTitles || [], series.authors || [], series.artists || [], series.tags || [],
      ).join(' ').toLowerCase().includes(keyword)) : items;
      shown = 0;
      list.textContent = '';
      if (matches.length) showMore();
      else status.textContent = items.length ? '没有匹配的作品' : '当前还没有作品，内容发布后即可检索。';
    } catch {
      if (request !== sequence) return;
      list.textContent = '';
      status.textContent = '作品目录加载失败，请点击“过滤”重试。';
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); filter(); });
  input.addEventListener('input', filter);
  more.addEventListener('click', showMore);
  filter();
}
