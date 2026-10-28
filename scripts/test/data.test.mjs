import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGallery } from '../lib/data.mjs';

const FIXTURES = fileURLToPath(new URL('../../packages/core/test/fixtures/data', import.meta.url));

test('测试样本整套加载：两个作品、三期、四话、八页、五个框', async () => {
  const g = await loadGallery({ dataDir: FIXTURES });
  assert.deepEqual(g.totals, { series: 2, issues: 3, chapters: 4, pages: 8, boxes: 5 });
  assert.deepEqual(g.series.map((s) => s.id), ['zeta', 'sample']); // zeta sort=0 排前
  const c3 = g.chapters.find((c) => c.key === 'sample/vol02/c003');
  assert.equal(c3.hasText, false);
  assert.equal(c3.prev, 'sample/vol01/c002');
});

test('空目录 / 不存在的目录得到空模型，而不是报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-empty-'));
  const g = await loadGallery({ dataDir: dir });
  assert.equal(g.totals.chapters, 0);
  const g2 = await loadGallery({ dataDir: join(dir, 'nope') });
  assert.equal(g2.totals.series, 0);
});

test('文件名与 id 不一致、text 路径与 chapter 不一致，一次全列出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-bad-'));
  await cp(FIXTURES, dir, { recursive: true });
  await mkdir(join(dir, 'meta'), { recursive: true });
  await writeFile(join(dir, 'meta', 'wrong-name.yaml'), 'id: other\ntitle: x\n');
  await writeFile(join(dir, 'text', 'sample', 'vol01', 'c999.json'), JSON.stringify({ chapter: 'sample/vol01/c001', pages: [] }));
  await assert.rejects(loadGallery({ dataDir: dir }), (e) => {
    assert.match(e.message, /wrong-name/);
    assert.match(e.message, /c999/);
    assert.match(e.message, /重复/); // c999.json 冒充 c001，与真 c001 撞 chapter
    assert.equal(e.issues.length, 3, e.message);
    return true;
  });
});

test('meta/text 大写与混合大小写扩展名明确报错，不静默忽略', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-extension-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(FIXTURES, dir, { recursive: true });
  await writeFile(join(dir, 'meta', 'other.YAML'), 'not yaml');
  await writeFile(join(dir, 'meta', 'another.YmL'), 'not yaml');
  await writeFile(join(dir, 'text', 'sample', 'vol01', 'c999.Json'), 'not json');
  await assert.rejects(loadGallery({ dataDir: dir }), (error) => {
    assert.equal(error.issues.length, 3, error.message);
    for (const name of ['other.YAML', 'another.YmL', 'c999.Json']) assert.ok(error.message.includes(name));
    assert.ok(error.issues.every((issue) => issue.includes('扩展名必须小写')));
    return true;
  });
});
