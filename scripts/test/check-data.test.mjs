import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const SCRIPT = join(ROOT, 'scripts', 'check-data.mjs');

async function setup(t, { copy = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pagehaven-check-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'data');
  if (copy) await cp(FIXTURES, data, { recursive: true });
  else await mkdir(data);
  return { dir, data };
}

function run(dir, args = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: 'data', CONFIG_FILE: join(dir, 'missing-site.yaml'), ...env },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { status: result.status, out: result.stdout, err: result.stderr };
}

async function snapshot(dir, base = dir) {
  const files = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await snapshot(file, base));
    else files.push({ file: file.slice(base.length), bytes: (await readFile(file)).toString('base64'), mtime: (await stat(file)).mtimeMs });
  }
  return files;
}

test('check:data 直接检查自定义数据目录，汇总正式稿及可检索文字，且不生成或修改文件', async (t) => {
  const { dir, data } = await setup(t);
  const before = await snapshot(dir);
  const result = run(dir, ['--json']);
  assert.equal(result.status, 0, result.out + result.err);
  assert.equal(result.err, '');
  const report = JSON.parse(result.out);
  assert.equal(report.ok, true);
  assert.equal(report.dataDir, resolve(data));
  assert.deepEqual(report.totals, { series: 2, issues: 3, chapters: 4, pages: 8, boxes: 5 });
  assert.deepEqual(report.coverage, { withText: 3, withoutText: 1, searchableChapters: 3, searchablePages: 3, searchableBoxes: 4 });
  assert.deepEqual(report.missingText, ['sample/vol02/c003']);
  assert.deepEqual(report.emptyText, []);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(await snapshot(dir), before, '检查不能修改 data 或产生 dist/out');
  assert.deepEqual((await readdir(dir)).sort(), ['data']);

  const human = run(dir);
  assert.equal(human.status, 0, human.out + human.err);
  assert.match(human.out, /台词稿 3 \/ 4 话；有可检索文字 3 话、3 页、4 个框/);
  assert.match(human.out, /sample\/vol02\/c003：尚无台词稿/);
});

test('check:data 接受空库，中文报告不把没有章节表达为完整覆盖', async (t) => {
  const { dir } = await setup(t, { copy: false });
  const result = run(dir);
  assert.equal(result.status, 0, result.out + result.err);
  assert.match(result.out, /尚无章节，暂不计算台词覆盖率/);
  assert.doesNotMatch(result.out, /0 \/ 0|100%/);
  const json = JSON.parse(run(dir, ['--json']).out);
  assert.deepEqual(json.coverage, { withText: 0, withoutText: 0, searchableChapters: 0, searchablePages: 0, searchableBoxes: 0 });
  assert.deepEqual(json.missingText, []);
});

test('check:data 区分无稿、空稿和只有标点的稿，缺少可检索文字不判失败', async (t) => {
  const { dir, data } = await setup(t);
  await writeFile(join(data, 'text', 'sample', 'vol01', 'c002.json'), JSON.stringify({ chapter: 'sample/vol01/c002', pages: [] }));
  await mkdir(join(data, 'text', 'sample', 'vol02'), { recursive: true });
  await writeFile(join(data, 'text', 'sample', 'vol02', 'c003.json'), JSON.stringify({
    chapter: 'sample/vol02/c003', pages: [{ n: 1, boxes: [{ i: 0, x: 0, y: 0, w: 0, h: 0, t: '……', tn: '' }] }],
  }));
  await rm(join(data, 'text', 'zeta', 'v1', 'ch1.json'));
  const result = run(dir, ['--json']);
  assert.equal(result.status, 0, result.out + result.err);
  const report = JSON.parse(result.out);
  assert.deepEqual(report.coverage, { withText: 3, withoutText: 1, searchableChapters: 1, searchablePages: 1, searchableBoxes: 2 });
  assert.deepEqual(report.emptyText, ['sample/vol01/c002', 'sample/vol02/c003']);
  assert.deepEqual(report.missingText, ['zeta/v1/ch1']);
  const human = run(dir);
  assert.match(human.out, /sample\/vol01\/c002：已有台词稿，尚无可检索文字/);
  assert.match(human.out, /zeta\/v1\/ch1：尚无台词稿/);
});

test('check:data 汇总多文件错误，JSON 失败报告不混入日志且不伪造统计', async (t) => {
  const { dir, data } = await setup(t);
  await writeFile(join(data, 'meta', 'broken.yaml'), 'id: [\n');
  await writeFile(join(data, 'text', 'sample', 'vol01', 'c999.json'), '{\n');
  const before = await snapshot(dir);
  const result = run(dir, ['--json']);
  assert.equal(result.status, 1, result.out + result.err);
  assert.equal(result.err, '');
  const report = JSON.parse(result.out);
  assert.equal(report.ok, false);
  assert.equal(report.totals, null);
  assert.equal(report.coverage, null);
  assert.equal(report.issues.length, 2);
  assert.ok(report.issues.some((issue) => /meta[\\/]broken\.yaml/.test(issue)));
  assert.ok(report.issues.some((issue) => /c999\.json/.test(issue)));
  assert.deepEqual(await snapshot(dir), before);
  const human = run(dir);
  assert.equal(human.status, 1);
  assert.match(human.out, /共 2 处错误/);
});

test('check:data 对不存在的目录与普通文件明确失败，不误判为空库', async (t) => {
  const { dir } = await setup(t, { copy: false });
  const absent = run(dir, ['--json'], { DATA_DIR: 'typo-data' });
  assert.equal(absent.status, 1, absent.out + absent.err);
  assert.match(JSON.parse(absent.out).issues[0], /数据目录不存在/);
  await writeFile(join(dir, 'plain-file'), 'not a directory');
  const file = run(dir, ['--json'], { DATA_DIR: 'plain-file' });
  assert.equal(file.status, 1, file.out + file.err);
  assert.match(JSON.parse(file.out).issues[0], /数据路径不是目录/);
});

test('check:data 帮助无需数据或站点配置，未知参数以纯 JSON 或中文报告失败', async (t) => {
  const { dir } = await setup(t, { copy: false });
  const help = run(dir, ['--help'], { DATA_DIR: 'does-not-exist' });
  assert.equal(help.status, 0, help.out + help.err);
  assert.match(help.out, /用法：pnpm run check:data/);
  const invalid = run(dir, ['--json', '--write']);
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.out).issues[0], /未知参数：--write/);
  const positional = run(dir, ['data']);
  assert.equal(positional.status, 1);
  assert.match(positional.out, /未知参数：data/);
});
