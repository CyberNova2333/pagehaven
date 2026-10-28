import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestLabelPlus } from '../lib/ingest-labelplus.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const SCRIPT = join(ROOT, 'scripts', 'ingest-labelplus.mjs');
const quiet = { note() {}, ok() {} };
const NEW_CHAPTER = 'sample/vol02/c003';
const EXISTING_CHAPTER = 'zeta/v1/ch1';
const UNCHANGED_CHAPTER = 'sample/vol01/c002';
const PRIVATE_LINE = '预览不应打印的台词';

function draft(page = '001.jpg', line = PRIVATE_LINE) {
  return `1,0\n-\n框内\n框外\n-\n备注\n>>>>>>>>[${page}]<<<<<<<<\n----------------[1]----------------[0.1,0.2,1]\n${line}\n`;
}

function run(dataDir, args = ['--dry-run'], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dataDir, CHAPTERS: '', LABELPLUS_PAGES: '', ...env },
  });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'pagehaven-ingest-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await cp(FIXTURES, data, { recursive: true });
  return { root, data };
}

async function putDraft(data, chapter, content = draft()) {
  const file = join(data, 'raw', 'labelplus', ...chapter.split('/')) + '.txt';
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

// 连目录也一起核对：预览不能留下空目录，原文件的字节与修改时间也不能变化。
async function snapshot(dir) {
  const files = [];
  async function visit(base, prefix = '') {
    for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(base, entry.name);
      const path = `${prefix}${entry.name}`;
      const info = await stat(file);
      files.push({ path, mtimeMs: info.mtimeMs, bytes: entry.isFile() ? (await readFile(file)).toString('base64') : null });
      if (entry.isDirectory()) await visit(file, `${path}/`);
    }
  }
  await visit(dir);
  return files;
}

async function mixedChanges(t) {
  const fixture = await setup(t);
  await putDraft(fixture.data, UNCHANGED_CHAPTER, draft('001.jpg', '保持原样'));
  const seeded = await ingestLabelPlus({ dataDir: fixture.data, chapters: [UNCHANGED_CHAPTER], log: quiet });
  assert.deepEqual(seeded.errors, []);
  await putDraft(fixture.data, NEW_CHAPTER);
  await putDraft(fixture.data, EXISTING_CHAPTER, draft('002.jpg', '更新后的台词'));
  return fixture;
}

test('LabelPlus 预览列出新增、更新与未变，重复预览保留所有文件字节和修改时间', async (t) => {
  const { data } = await mixedChanges(t);
  const targetDir = join(data, 'text', 'sample', 'vol02');
  assert.equal(existsSync(targetDir), false);
  const before = await snapshot(data);
  for (let i = 0; i < 2; i += 1) {
    const result = run(data);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /将新增 sample\/vol02\/c003/);
    assert.match(result.output, /将更新 zeta\/v1\/ch1/);
    assert.match(result.output, /sample\/vol01\/c002：内容未变/);
    assert.match(result.output, /预览：新增 1 话，更新 1 话，未变 1 话，提示 \d+ 条，错误 0 条/);
    assert.ok(!result.output.includes(PRIVATE_LINE), '预览只显示计划，不回显台词正文');
    assert.deepEqual(await snapshot(data), before);
    assert.equal(existsSync(targetDir), false, '不为计划新增的话创建空目录');
  }
});

test('LabelPlus 库的预览计划与普通写入一致，written 只记录实际写入', async (t) => {
  const { data } = await mixedChanges(t);
  const before = await snapshot(data);
  const preview = await ingestLabelPlus({ dataDir: data, dryRun: true, log: quiet });
  assert.deepEqual(preview.planned, [
    { chapter: NEW_CHAPTER, action: 'create' },
    { chapter: EXISTING_CHAPTER, action: 'update' },
  ]);
  assert.deepEqual(preview.written, []);
  assert.deepEqual(preview.unchanged, [UNCHANGED_CHAPTER]);
  assert.deepEqual(await snapshot(data), before);
  const applied = await ingestLabelPlus({ dataDir: data, log: quiet });
  assert.deepEqual(applied.planned, preview.planned);
  assert.deepEqual(applied.written, [NEW_CHAPTER, EXISTING_CHAPTER]);
  assert.deepEqual(applied.unchanged, preview.unchanged);
  const repeat = await ingestLabelPlus({ dataDir: data, dryRun: true, log: quiet });
  assert.deepEqual(repeat.planned, []);
  assert.deepEqual(repeat.written, []);
  assert.equal(repeat.unchanged.length, 3);
});

test('LabelPlus 预览汇总错页和坏稿，有效章节也不会落盘', async (t) => {
  const { data } = await setup(t);
  await putDraft(data, NEW_CHAPTER, draft('002.jpg'));
  await putDraft(data, UNCHANGED_CHAPTER, '这不是 LabelPlus 稿\n');
  await putDraft(data, EXISTING_CHAPTER, draft('002.jpg'));
  const before = await snapshot(data);
  const result = run(data);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /sample\/vol02\/c003 只有 1 页/);
  assert.match(result.output, /sample\/vol01\/c002\.txt：没有任何文件块/);
  assert.match(result.output, /将更新 zeta\/v1\/ch1/);
  assert.match(result.output, /预览：新增 0 话，更新 1 话，未变 0 话，提示 \d+ 条，错误 2 条/);
  assert.deepEqual(await snapshot(data), before);
  const preview = await ingestLabelPlus({ dataDir: data, dryRun: true, log: quiet });
  assert.deepEqual(preview.planned, [{ chapter: EXISTING_CHAPTER, action: 'update' }]);
  assert.equal(preview.errors.length, 2);
  assert.deepEqual(preview.written, []);
});

test('LabelPlus 预览沿用 CHAPTERS 筛选和页码策略', async (t) => {
  const { data } = await setup(t);
  await putDraft(data, NEW_CHAPTER, draft('002.jpg'));
  await putDraft(data, EXISTING_CHAPTER, '未选中的坏稿\n');
  const before = await snapshot(data);
  const selected = { CHAPTERS: ` ${NEW_CHAPTER} , ` };
  const failed = run(data, ['--dry-run'], selected);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /只有 1 页/);
  assert.ok(!failed.output.includes('没有任何文件块'), '不解析未选择的章节');
  const fixed = run(data, ['--dry-run'], { ...selected, LABELPLUS_PAGES: 'sequence' });
  assert.equal(fixed.status, 0, fixed.output);
  assert.match(fixed.output, /将新增 sample\/vol02\/c003/);
  assert.match(fixed.output, /本次处理 1 份（CHAPTERS 限定）/);
  assert.deepEqual(await snapshot(data), before);
});

test('LabelPlus 帮助和未知参数都不进入写入流程', async (t) => {
  const { root, data } = await setup(t);
  await putDraft(data, NEW_CHAPTER);
  const before = await snapshot(data);
  for (const args of [['--unknown'], ['--dry-run', '--unknown'], ['unexpected'], [''], ['--dry-run', '']]) {
    const result = run(data, args);
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(await snapshot(data), before);
  }
  const missing = join(root, 'missing');
  const help = run(missing, ['--help']);
  assert.equal(help.status, 0, help.output);
  assert.match(help.output, /--dry-run/);
  assert.match(help.output, /CHAPTERS/);
  assert.equal(existsSync(missing), false);
});

test('LabelPlus 预览的早期校验失败仍返回空计划且不改文件', async (t) => {
  const { data } = await setup(t);
  await putDraft(data, NEW_CHAPTER);
  const before = await snapshot(data);
  const invalidStrategy = await ingestLabelPlus({ dataDir: data, dryRun: true, pageStrategy: 'invalid', log: quiet });
  assert.deepEqual(invalidStrategy.planned, []);
  assert.deepEqual(invalidStrategy.written, []);
  assert.equal(invalidStrategy.errors.length, 1);
  assert.deepEqual(await snapshot(data), before);
  await writeFile(join(data, 'meta', 'bad.yaml'), 'id: [\n');
  const invalidBefore = await snapshot(data);
  const invalidData = await ingestLabelPlus({ dataDir: data, dryRun: true, log: quiet });
  assert.deepEqual(invalidData.planned, []);
  assert.deepEqual(invalidData.written, []);
  assert.ok(invalidData.errors.length >= 1);
  assert.deepEqual(await snapshot(data), invalidBefore);
});
