import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { parseSeriesMeta, parseChapterText, SeriesSchema } from '../src/index.js';

const fixture = (p) => fileURLToPath(new URL(`./fixtures/data/${p}`, import.meta.url));

test('样本 meta 通过校验，published 的两种写法都归一成字符串', async () => {
  const meta = parseSeriesMeta(yaml.load(await readFile(fixture('meta/sample.yaml'), 'utf8')), { source: 'sample.yaml' });
  assert.equal(meta.id, 'sample');
  assert.equal(meta.issues[0].published, '2026-01-01'); // YAML 里不加引号 → Date → 字符串
  assert.equal(meta.issues[1].published, '2026-06-01'); // 加引号 → 直接是字符串
  assert.equal(meta.issues[0].chapters[0].pages.length, 3);
});

test('样本 text 通过校验', async () => {
  const text = parseChapterText(JSON.parse(await readFile(fixture('text/sample/vol01/c001.json'), 'utf8')));
  assert.equal(text.chapter, 'sample/vol01/c001');
  assert.equal(text.pages[0].boxes.length, 2);
});

test('id 不合规、页码不连续、未知字段、坐标出界都被拦下，且一次列全', () => {
  const bad = {
    id: 'Bad_ID',
    title: 'x',
    extra: 1,
    issues: [
      {
        id: 'v1',
        number: 1,
        title: 'v',
        chapters: [{ id: 'c1', number: 1, title: 'c', pages: [{ n: 2, img: '0123456789ab', w: 1, h: 1 }] }],
      },
    ],
  };
  assert.throws(() => parseSeriesMeta(bad, { source: 'bad.yaml' }), (e) => {
    assert.match(e.message, /id/);
    assert.match(e.message, /连续递增/);
    assert.match(e.message, /extra/);
    assert.ok(e.issues.length >= 3, `应列出至少 3 处，实际 ${e.issues.length}`);
    return true;
  });
  assert.throws(() => parseChapterText({ chapter: 'a/b/c', pages: [{ n: 1, boxes: [{ i: 0, x: 0.9, y: 0, w: 0.2, h: 0, t: '', tn: '' }] }] }), /超出页面/);
  assert.throws(() => parseChapterText({ chapter: 'a/b', pages: [] }), /<series>\/<issue>\/<chapter>/);
});

test('数字 id 提示加引号；重复 id 被拦', () => {
  assert.throws(() => parseSeriesMeta({ id: 12, title: 'x' }), /引号/);
  const r = SeriesSchema.safeParse({
    id: 's',
    title: 'x',
    issues: [
      { id: 'v', number: 1, title: 'v', chapters: [{ id: 'c', number: 1, title: 'c', pages: [{ n: 1, img: '0123456789ab', w: 1, h: 1 }] }] },
      { id: 'v', number: 2, title: 'v2', chapters: [{ id: 'c', number: 1, title: 'c', pages: [{ n: 1, img: '0123456789ab', w: 1, h: 1 }] }] },
    ],
  });
  assert.equal(r.success, false);
  assert.match(r.error.issues.map((i) => i.message).join('\n'), /期的 id 重复/);
});
