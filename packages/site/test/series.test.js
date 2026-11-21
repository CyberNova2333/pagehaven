// 目录决定作品页可恢复的章节和显示标题。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountSeriesReading } from '../src/lib/continue-reading.js';

function seriesFixture({ chapters = [
  { url: '/sample/v/c1/', title: '目录第一话', pages: 4 },
  { url: '/sample/v/c2/', title: '目录第二话', pages: 2 },
], records = [], denied = '' } = {}) {
  const link = chapters.length ? Object.assign(new EventTarget(), {
    href: chapters[0].url, textContent: '开始阅读 →', getAttribute(key) { return this[key]; },
  }) : null;
  const stored = new Map(records.map((value, index) => [`gallery:progress:sample/v/c${index}`, typeof value === 'string' ? value : JSON.stringify(value)]));
  stored.set('gallery:reader:settings', JSON.stringify({ url: chapters[0]?.url, ts: 10000 }));
  const before = [...stored];
  const context = Object.assign(new EventTarget(), {
    setTimeout, clearTimeout,
    document: Object.assign(new EventTarget(), { getElementById: (id) => id === 'start-reading' ? link : id === 'series-chapters' ? { textContent: JSON.stringify(chapters) } : null }),
  });
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
  mountSeriesReading(context);
  assert.deepEqual([...stored], before, '只读取进度，不删除或改写旧记录');
  return { win: context, link, stored };
}

function seriesPage(options) {
  return seriesFixture(options).link;
}

test('作品页从后退缓存恢复时重选最新话，激活旧入口前重新核对页码', () => {
  const { win, link, stored } = seriesFixture({ records: [{ url: '/sample/v/c1/', n: 1, ts: 10 }] });
  const url = '/sample/v/c2/';
  const key = 'gallery:progress:sample/v/c2';
  stored.set(key, JSON.stringify({ url, n: 1, ts: 20 }));
  win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(link.href, url + '#p1');
  assert.equal(link.textContent, '继续阅读：目录第二话 →');
  stored.set(key, JSON.stringify({ url, n: 2, ts: 21 }));
  link.dispatchEvent(new Event('click'));
  assert.equal(link.href, url + '#p2');
  stored.clear();
  win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(link.href, '/sample/v/c1/');
  assert.equal(link.textContent, '开始阅读 →');
});

test('作品页：只接受当前目录完整 URL，已删除章节和同前缀伪路径不覆盖有效进度', () => {
  const link = seriesPage({ records: [
    { url: '/sample/v/c1/', n: 2, ts: 1 },
    { url: '/sample/v/c2/', n: 2, ts: 2, title: '不可信标题' },
    { url: '/sample/v/deleted/', n: 9, ts: 100 },
    { url: '/sample/v/c2/extra/', n: 1, ts: 200 },
    { url: '/sample/v/c2/#p1', n: 1, ts: 300 },
    { url: '/another/v/c1/', n: 1, ts: 400 },
    { url: 'javascript:alert(1)', n: 1, ts: 500 },
  ] });
  assert.equal(link.href, '/sample/v/c2/#p2');
  assert.equal(link.textContent, '继续阅读：目录第二话 →');
});

test('作品页：只有删除章节、null 或坏数据时保留默认开始阅读', () => {
  const link = seriesPage({ records: [null, '{broken', [], 3, {}, { url: '/sample/v/deleted/', ts: 10 }] });
  assert.equal(link.href, '/sample/v/c1/');
  assert.equal(link.textContent, '开始阅读 →');
});

test('作品页：坏记录不阻断后面的有效记录', () => {
  const link = seriesPage({ records: [null, '{broken', [], 3, {}, { url: '/sample/v/c1/', n: 3, ts: 10 }] });
  assert.equal(link.href, '/sample/v/c1/#p3');
});

test('作品页：存储 getter 或 length 抛错保留默认链接，空章节不读取存储', () => {
  for (const denied of ['getter', 'length']) {
    const link = seriesPage({ denied });
    assert.equal(link.href, '/sample/v/c1/');
    assert.equal(link.textContent, '开始阅读 →');
  }
  assert.equal(seriesPage({ chapters: [], denied: 'getter' }), null);
});

test('作品页：单条 key 或 getItem 读取失败后仍能恢复后面的有效记录', () => {
  for (const denied of ['key', 'getItem']) {
    const link = seriesPage({ denied, records: [null, { url: '/sample/v/c2/', n: 2, ts: 10 }] });
    assert.equal(link.href, '/sample/v/c2/#p2');
  }
});

test('作品页：无效页码恢复到第一页，合法旧页码钳制到当前范围', () => {
  for (const [n, expected] of [[undefined, 1], [null, 1], ['3', 1], [{}, 1], [[], 1], [1.5, 1], [0, 1], [-2, 1], [99, 4], [3, 3], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    const link = seriesPage({ records: [{ url: '/sample/v/c1/', n, ts: 10 }] });
    assert.equal(link.href, `/sample/v/c1/#p${expected}`);
  }
});

test('作品页：字符串与无限时间戳不抢占正常最近记录', () => {
  const link = seriesPage({ records: [
    { url: '/sample/v/c1/', n: 4, ts: 10 },
    { url: '/sample/v/c2/', n: 1, ts: '999999' },
    '{"url":"/sample/v/c2/","n":2,"ts":1e309}',
  ] });
  assert.equal(link.href, '/sample/v/c1/#p4');
});
