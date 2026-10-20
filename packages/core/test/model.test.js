import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGallery, imageKey, urlFor, chapterKey } from '../src/index.js';

const page = (n) => ({ n, img: 'abcdefabcdef', w: 100, h: 200 });
const series = (id, sort, title, issues) => ({ id, title, sort, issues });
const issue = (id, number, chapters) => ({ id, number, title: id, chapters });
const chapter = (id, number, pages) => ({ id, number, title: id, pages });

test('key / URL / 图片 key 的拼法', () => {
  assert.equal(chapterKey('s', 'v', 'c'), 's/v/c');
  assert.equal(urlFor('s', 'v', 'c'), '/s/v/c/');
  assert.equal(imageKey('img/', 's/v/c', 3, 'abcdefabcdef', 'webp'), 'img/s/v/c/3-abcdefabcdef.webp');
});

test('排序：作品按 sort，期与话按 number；上一话/下一话在作品内跨期相连', () => {
  const g = buildGallery([
    series('b', 2, 'B', [issue('v2', 2, [chapter('c3', 3, [page(1)])]), issue('v1', 1, [chapter('c2', 2, [page(1)]), chapter('c1', 1, [page(1)])])]),
    series('a', 1, 'A', [issue('v1', 1, [chapter('c1', 1, [page(1), page(2)])])]),
  ]);
  assert.deepEqual(g.series.map((s) => s.id), ['a', 'b']);
  const b = g.series[1];
  assert.deepEqual(b.issues.map((i) => i.id), ['v1', 'v2']);
  assert.deepEqual(b.issues[0].chapters.map((c) => c.id), ['c1', 'c2']);
  const [c1, c2, c3] = b.issues.flatMap((i) => i.chapters);
  assert.equal(c1.prev, null);
  assert.equal(c1.next, 'b/v1/c2');
  assert.equal(c2.next, 'b/v2/c3');
  assert.equal(c3.prev, 'b/v1/c2');
  assert.equal(c3.next, null);
  assert.equal(g.series[0].issues[0].chapters[0].next, null); // 不跨作品
  assert.deepEqual(g.totals, { series: 2, issues: 3, chapters: 4, pages: 5, boxes: 0 });
  assert.equal(g.chapters.length, 4);
});

test('台词稿按页挂到模型上，框按 i 排序；没有稿的话 hasText=false 且 boxes 为空', () => {
  const texts = new Map([
    ['a/v1/c1', { chapter: 'a/v1/c1', pages: [{ n: 2, boxes: [{ i: 1, x: 0, y: 0, w: 0, h: 0, t: 'b', tn: 'b' }, { i: 0, x: 0, y: 0, w: 0, h: 0, t: 'a', tn: 'a' }] }] }],
  ]);
  const g = buildGallery([series('a', 0, 'A', [issue('v1', 1, [chapter('c1', 1, [page(1), page(2)]), chapter('c2', 2, [page(1)])])])], texts);
  const [c1, c2] = g.chapters;
  assert.equal(c1.hasText, true);
  assert.deepEqual(c1.pages[0].boxes, []);
  assert.deepEqual(c1.pages[1].boxes.map((b) => b.t), ['a', 'b']);
  assert.equal(c2.hasText, false);
  assert.equal(g.totals.boxes, 2);
  assert.equal(c1.pages[1].keys.webp, 'img/a/v1/c1/2-abcdefabcdef.webp');
});

test('台词稿对不上 meta 时报错：多出来的页、不存在的话', () => {
  const s = [series('a', 0, 'A', [issue('v1', 1, [chapter('c1', 1, [page(1)])])])];
  assert.throws(() => buildGallery(s, new Map([['a/v1/c1', { chapter: 'a/v1/c1', pages: [{ n: 5, boxes: [] }] }]])), /第 5 页/);
  assert.throws(() => buildGallery(s, new Map([['a/v1/zzz', { chapter: 'a/v1/zzz', pages: [] }]])), /没有对应的话/);
  assert.throws(() => buildGallery([...s, ...s]), /作品 id 重复/);
});
