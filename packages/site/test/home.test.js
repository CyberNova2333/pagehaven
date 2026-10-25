// 执行首页真实内联脚本，验证当前目录与浏览器旧阅读记录之间的边界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
const script = /<script is:inline>\s*([\s\S]*?)<\/script>/.exec(source)[1];

function home({ urls = [], chapters = urls.map((url, i) => ({ url, title: `第 ${i + 1} 话`, series: '示例作品', issue: '第一卷', pages: 4 })), records = [], denied = '' } = {}) {
  const node = () => ({
    children: [], hidden: true, textContent: '', listeners: new Map(),
    appendChild(child) { this.children.push(child); },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
  });
  const nodes = new Map(['random-pool', 'random-btn', 'continue', 'continue-list'].map((id) => [id, node()]));
  nodes.get('random-pool').textContent = JSON.stringify(chapters);
  const stored = new Map(records.map((value, index) => [`gallery:progress:sample/v/c${index}`, typeof value === 'string' ? value : JSON.stringify(value)]));
  stored.set('unrelated-preference', JSON.stringify({ url: urls[0], title: '不是阅读进度' }));
  const before = [...stored];
  const context = {
    document: { getElementById: (id) => nodes.get(id), createElement: node },
    location: { href: '/' },
  };
  Object.defineProperty(context, 'localStorage', {
    get() {
      if (denied === 'getter') throw new Error('Storage denied');
      return {
        get length() {
          if (denied === 'length') throw new Error('Storage length denied');
          return stored.size;
        },
        key(i) {
          if (denied === 'key' && i === 0) throw new Error('Storage key denied');
          return [...stored.keys()][i];
        },
        getItem(key) {
          if (denied === 'getItem' && key === [...stored.keys()][0]) throw new Error('Storage item denied');
          return stored.get(key);
        },
      };
    },
  });
  runInNewContext(script, context);
  return { nodes, location: context.location, stored, before };
}

test('首页：空目录不再显示已移除作品的旧阅读记录', () => {
  const h = home({ records: [{ url: '/removed/v/c1/', title: '已移除的话', series: '旧作品', n: 2, ts: 10 }] });
  assert.equal(h.nodes.get('continue').hidden, true);
  assert.equal(h.nodes.get('continue-list').children.length, 0);
  assert.deepEqual([...h.stored], h.before, '只过滤显示，不清空浏览器存储');
});

test('首页：只保留当前章节，坏记录跳过，正常记录仍按时间取最近三项', () => {
  const urls = Array.from({ length: 4 }, (_, i) => `/sample/v/c${i + 1}/`);
  const records = urls.map((url, i) => ({ url, title: '过期标题', series: '过期作品', issue: '过期期名', n: i + 1, ts: i }));
  records.push({ url: '/removed/v/c1/', title: '旧记录', ts: 100 }, '{broken', null, { url: 'javascript:alert(1)', ts: 200 }, { url: urls[0] + 'removed/', ts: 300 });
  const h = home({ urls, records });
  const rows = h.nodes.get('continue-list').children;
  assert.equal(h.nodes.get('continue').hidden, false);
  assert.deepEqual(rows.map((row) => row.children[0].href), ['/sample/v/c4/#p4', '/sample/v/c3/#p3', '/sample/v/c2/#p2']);
  assert.equal(rows[0].children[0].textContent, '第 4 话');
  assert.equal(rows[0].children[1].textContent, '示例作品 · 第一卷');
  assert.deepEqual([...h.stored], h.before);
});

test('首页：存储 getter 或 length 抛错时仍可随机阅读当前章节', () => {
  for (const denied of ['getter', 'length']) {
    const h = home({ urls: ['/sample/v/c1/'], denied });
    assert.equal(h.nodes.get('continue').hidden, true);
    h.nodes.get('random-btn').listeners.get('click')();
    assert.equal(h.location.href, '/sample/v/c1/');
    assert.deepEqual([...h.stored], h.before);
  }
});

test('首页：单条 key 或 getItem 读取失败后仍能显示有效记录', () => {
  for (const denied of ['key', 'getItem']) {
    const h = home({ urls: ['/sample/v/c1/'], denied, records: [null, { url: '/sample/v/c1/', n: 3, ts: 10 }] });
    assert.equal(h.nodes.get('continue-list').children[0].children[0].href, '/sample/v/c1/#p3');
    assert.deepEqual([...h.stored], h.before);
  }
});

test('首页：无效页码回第一页，删页后的旧页码限制到当前末页', () => {
  for (const [n, expected] of [[undefined, 1], [null, 1], ['3', 1], [{}, 1], [[], 1], [1.5, 1], [0, 1], [-2, 1], [99, 4], [3, 3], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    const h = home({ urls: ['/sample/v/c1/'], records: [{ url: '/sample/v/c1/', n, ts: 10 }] });
    assert.equal(h.nodes.get('continue-list').children[0].children[0].href, `/sample/v/c1/#p${expected}`);
    assert.deepEqual([...h.stored], h.before);
  }
});

test('首页：异常时间戳不抢占有效最近记录，同一章节只显示一次', () => {
  const urls = ['/sample/v/c1/', '/sample/v/c2/', '/sample/v/c3/'];
  const h = home({ urls, records: [
    { url: urls[0], ts: '999999', n: 2 },
    '{"url":"/sample/v/c2/","ts":1e309,"n":3}',
    { url: urls[2], ts: 5, n: 4 },
    { url: urls[2], ts: 2, n: 1 },
  ] });
  const rows = h.nodes.get('continue-list').children;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].children[0].href, '/sample/v/c3/#p4');
  assert.deepEqual([...h.stored], h.before);
});

test('首页：按作品取目录最后一话，末尾空期不隐藏已有章节', () => {
  const chapter = (title) => ({ title, url: `/${title}/`, pages: [{}] });
  const gallery = { series: [
    { title: '甲', issues: [{ title: '一期', chapters: [chapter('甲一'), chapter('甲二')] }, { title: '二期', chapters: [] }] },
    { title: '乙', issues: [{ title: '一期', chapters: [chapter('乙一')] }, { title: '二期', chapters: [chapter('乙二')] }] },
    { title: '空作品', issues: [] },
  ] };
  const frontmatter = source.split('---')[1].replace(/^import .*;\r?\n/gm, '');
  const latest = runInNewContext(frontmatter + '\n;latest;', {
    gallery, siteConfig: { site: {}, images: {} }, chapterCount: (s) => s.issues.reduce((n, issue) => n + issue.chapters.length, 0),
  });
  assert.deepEqual(Array.from(latest, (item) => [item.series.title, item.issue.title, item.chapter.title]), [['甲', '一期', '甲二'], ['乙', '二期', '乙二']]);
  assert.match(source, /<h2>各作品最新一话<\/h2>/);
});
