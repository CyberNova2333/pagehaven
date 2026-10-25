import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountSearch } from '../src/mount.js';

function searchPage(coverage) {
  const node = () => ({
    textContent: '', value: '', hidden: false, firstChild: null,
    addEventListener() {}, removeEventListener() {},
  });
  const nodes = new Map(['config', 'form', 'input', 'status', 'results', 'more', 'coverage'].map((name) => [`search-${name}`, node()]));
  nodes.get('search-config').textContent = JSON.stringify({ coverage });
  let requests = 0;
  const search = mountSearch({
    document: { getElementById: (id) => nodes.get(id) },
    location: { search: '?q=示例' },
    fetchImpl: async () => { requests++; throw new Error('空数据不能发起检索请求'); },
  });
  return { search, nodes, get requests() { return requests; } };
}

test('搜索：空站与有章节但无台词使用不同提示，均不下载检索库', async () => {
  for (const [coverage, message] of [
    [{ chapters: 0, withText: 0, boxes: 0 }, '当前还没有作品，内容发布后即可检索。'],
    [{ chapters: 4, withText: 0, boxes: 0 }, '当前尚未收录可检索的台词，作品和漫画仍可正常浏览。'],
  ]) {
    const page = searchPage(coverage);
    assert.equal(page.nodes.get('search-status').textContent, message, '深链查询也应显示正确空状态');
    assert.deepEqual(await page.search.run('示例台词'), []);
    assert.equal(page.nodes.get('search-status').textContent, message);
    assert.equal(page.nodes.get('search-more').hidden, true);
    assert.equal(page.requests, 0);
    page.search.destroy();
  }
});
