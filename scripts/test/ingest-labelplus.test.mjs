// ingest:labelplus 的端到端测试：把测试样本复制到临时目录、放原始稿、真 spawn 脚本，
// 断言写出的 JSON、CHAPTERS 过滤、不重写、页码超出 meta 与 meta 里没有的话都报错且退出码非零，
// 以及只该提示不该拦的事（CHAPTERS 里没稿但 meta 有的话、解析器的可疑行、raw 里的非 .txt）退出码为 0。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures', 'data');
const SCRIPT = join(ROOT, 'scripts', 'ingest-labelplus.mjs');

function run(env) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CHAPTERS: '', LABELPLUS_PAGES: '', ...env },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** 复制样本到临时目录，返回 DATA_DIR */
async function setup(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-ingest-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const data = join(tmp, 'data');
  await cp(FIXTURES, data, { recursive: true });
  return data;
}

async function putDraft(data, key, content, ext = '.txt') {
  const file = join(data, 'raw', 'labelplus', ...key.split('/')) + ext;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

const label = (n, x, y, kind, ...lines) => [`----------------[${n}]----------------[${x},${y},${kind}]`, ...lines].join('\n');
const block = (name, ...labels) => [`>>>>>>>>[${name}]<<<<<<<<`, ...labels].join('\n');
const header = '1,0\n-\n框内\n框外\n-\n备注\n';

// sample/vol02/c003 在样本里只有 1 页、没有台词稿
const C003 =
  header +
  block('001.jpg', label(1, 0.1, 0.2, 1, '第三話', '餘燼'), label(2, 0.5, 0.5, 2, ''), label(3, 0.9, 0.9, 1, 'Ｅｎｄ')) +
  '\n';
// zeta/v1/ch1 有 2 页，样本已有台词稿（只有第 2 页）；这份稿只写第 2 页，且内容与样本不同
const CH1 = '\uFEFF' + (header + block('02.png', label(1, 0.4, 0.6, 1, '再见。'), label(2, 0.7, 0.8, 1, '後會有期'))).replace(/\n/g, '\r\n') + '\r\n';

test('全部原始稿：新话写出、已有稿重写、其余不动；再跑一次全部未变', { timeout: 60_000 }, async (t) => {
  const data = await setup(t);
  await putDraft(data, 'sample/vol02/c003', C003);
  await putDraft(data, 'zeta/v1/ch1', CH1);
  const before = JSON.parse(await readFile(join(data, 'text', 'sample', 'vol01', 'c001.json'), 'utf8'));

  const r = run({ DATA_DIR: data });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /原始稿 2 份，本次处理 2 份/);
  assert.match(r.out, /写出 2 话，未变 0 话/);

  const c003 = JSON.parse(await readFile(join(data, 'text', 'sample', 'vol02', 'c003.json'), 'utf8'));
  assert.deepEqual(c003, {
    chapter: 'sample/vol02/c003',
    pages: [
      {
        n: 1,
        boxes: [
          { i: 0, x: 0.1, y: 0.2, w: 0, h: 0, t: '第三話\n餘燼', tn: '第三话余烬' },
          { i: 1, x: 0.9, y: 0.9, w: 0, h: 0, t: 'Ｅｎｄ', tn: 'end' },
        ],
      },
    ],
  });
  // 磁盘上的字节：2 空格缩进、键顺序固定、末尾换行
  const raw = await readFile(join(data, 'text', 'sample', 'vol02', 'c003.json'), 'utf8');
  assert.equal(raw, JSON.stringify(c003, null, 2) + '\n');
  assert.ok(raw.indexOf('"chapter"') < raw.indexOf('"pages"'));

  const ch1 = JSON.parse(await readFile(join(data, 'text', 'zeta', 'v1', 'ch1.json'), 'utf8'));
  assert.deepEqual(ch1.pages.map((p) => p.n), [2]);
  assert.deepEqual(ch1.pages[0].boxes.map((b) => [b.t, b.tn]), [['再见。', '再见'], ['後會有期', '后会有期']]);
  assert.match(r.out, /zeta\/v1\/ch1：meta 里的第 1 页在稿里没有对应文件块/, '缺页只提示');
  // 没有原始稿的话不动
  assert.deepEqual(JSON.parse(await readFile(join(data, 'text', 'sample', 'vol01', 'c001.json'), 'utf8')), before);

  // 再跑：内容相同不重写（mtime 不变）
  const mtime = (await stat(join(data, 'text', 'sample', 'vol02', 'c003.json'))).mtimeMs;
  await new Promise((res) => setTimeout(res, 20));
  const r2 = run({ DATA_DIR: data });
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /写出 0 话，未变 2 话/);
  assert.equal((await stat(join(data, 'text', 'sample', 'vol02', 'c003.json'))).mtimeMs, mtime);
});

test('CHAPTERS 限定只处理列出的话；列出的话没有稿：meta 里有的只提示、没有的报错', { timeout: 60_000 }, async (t) => {
  const data = await setup(t);
  await putDraft(data, 'sample/vol02/c003', C003);
  await putDraft(data, 'zeta/v1/ch1', CH1);

  const r = run({ DATA_DIR: data, CHAPTERS: ' zeta/v1/ch1 , ' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /本次处理 1 份（CHAPTERS 限定）/);
  assert.ok(!existsSync(join(data, 'text', 'sample', 'vol02', 'c003.json')), '没列出的话不写');
  assert.equal(JSON.parse(await readFile(join(data, 'text', 'zeta', 'v1', 'ch1.json'), 'utf8')).pages[0].boxes.length, 2);

  // c002 在 meta 里、没有稿：这正是发布流水线开 ocr 要补的话，ingest:labelplus 不能在这里把发布拦下
  const r2 = run({ DATA_DIR: data, CHAPTERS: 'sample/vol01/c002' });
  assert.equal(r2.status, 0, r2.out);
  assert.match(
    r2.out,
    /⚠ CHAPTERS 里的 sample\/vol01\/c002 没有 LabelPlus 稿（raw\/labelplus\/sample\/vol01\/c002\.txt 不存在），跳过/,
  );
  assert.match(r2.out, /本次处理 0 份（CHAPTERS 限定）/);
  assert.match(r2.out, /写出 0 话，未变 0 话，提示 1 条，错误 0 条/);
  // meta 里也没有的 key 与格式不对的 key 仍是错误——大概率是拼错了
  const r3 = run({ DATA_DIR: data, CHAPTERS: 'sample/vol09/c099,bad key' });
  assert.notEqual(r3.status, 0);
  assert.match(r3.out, /✘ CHAPTERS 里的 sample\/vol09\/c099：meta 里没有这一话，也没有原始稿/);
  assert.match(r3.out, /「bad key」不是 <series>\/<issue>\/<chapter>/);
  assert.match(r3.out, /错误 2 条/);
});

test('只提示不拦：解析器的可疑行、raw 里的非 .txt 文件；.TXT 照常处理、点文件不管', { timeout: 60_000 }, async (t) => {
  const data = await setup(t);
  // 逗号后多了个空格：标签 1 与它的台词无声消失，这一定要在日志里看得见
  await putDraft(
    data,
    'sample/vol02/c003',
    header +
      '>>>>>>>>[001.jpg]<<<<<<<<\n----------------[1]----------------[0.5, 0.5, 1]\n这句台词去哪了\n' +
      label(2, 0.6, 0.6, 1, '还在') +
      '\n',
  );
  await putDraft(data, 'zeta/v1/ch1', CH1, '.TXT');
  await writeFile(join(data, 'raw', 'labelplus', 'sample', 'notes.docx'), 'x');
  await writeFile(join(data, 'raw', 'labelplus', '.gitkeep'), '');

  const r = run({ DATA_DIR: data });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /原始稿 2 份，本次处理 2 份/);
  assert.match(r.out, /⚠ raw\/labelplus\/sample\/notes\.docx：不是 \.txt，已忽略/);
  assert.ok(!r.out.includes('.gitkeep'), '点文件不提示');
  const draft = 'raw/labelplus/sample/vol02/c003\\.txt'; // 拼进 RegExp，所以只转义点号
  assert.match(
    r.out,
    new RegExp(`⚠ ${draft}：第 8 行：像分隔符但不完全匹配，不在任何标签下、已丢弃：「----------------\\[1\\]----------------\\[0\\.5, 0\\.5, 1\\]」`),
  );
  assert.match(r.out, new RegExp(`⚠ ${draft}：第 8 行起：文件块「001\\.jpg」头与第一个标签之间有 2 行内容`));
  // 第 4 条提示是 zeta/v1/ch1 缺第 1 页的那条
  assert.match(r.out, /提示 4 条，错误 0 条/);
  const c003 = JSON.parse(await readFile(join(data, 'text', 'sample', 'vol02', 'c003.json'), 'utf8'));
  assert.deepEqual(c003.pages[0].boxes.map((b) => b.t), ['还在']);
  const ch1 = JSON.parse(await readFile(join(data, 'text', 'zeta', 'v1', 'ch1.json'), 'utf8'));
  assert.deepEqual(ch1.pages.map((p) => p.n), [2], '.TXT 也当稿处理');
});

test('页码超出 meta 报错且不写；同一次里没问题的话照常写出；LABELPLUS_PAGES=sequence 可救', { timeout: 60_000 }, async (t) => {
  const data = await setup(t);
  // c003 只有 1 页，这份稿的文件名数字是 2、3
  await putDraft(data, 'sample/vol02/c003', header + block('002.jpg', label(1, 0.1, 0.1, 1, 'x')) + '\n' + block('003.jpg') + '\n');
  await putDraft(data, 'zeta/v1/ch1', CH1);

  const r = run({ DATA_DIR: data });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /稿里有第 2、3 页，但 meta 里 sample\/vol02\/c003 只有 1 页/);
  assert.match(r.out, /错误 1 条/);
  assert.ok(!existsSync(join(data, 'text', 'sample', 'vol02', 'c003.json')));
  assert.ok(existsSync(join(data, 'text', 'zeta', 'v1', 'ch1.json')) && r.out.includes('zeta/v1/ch1 → text/zeta/v1/ch1.json'));

  // 按顺序：002.jpg 是第 1 页，003.jpg 是第 2 页 → 仍超出；只留一个文件块就对了
  await putDraft(data, 'sample/vol02/c003', header + block('002.jpg', label(1, 0.1, 0.1, 1, 'x')) + '\n');
  const r2 = run({ DATA_DIR: data, CHAPTERS: 'sample/vol02/c003', LABELPLUS_PAGES: 'sequence' });
  assert.equal(r2.status, 0, r2.out);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'text', 'sample', 'vol02', 'c003.json'), 'utf8')).pages.map((p) => p.n), [1]);
  const r3 = run({ DATA_DIR: data, LABELPLUS_PAGES: 'nope' });
  assert.notEqual(r3.status, 0);
  assert.match(r3.out, /LABELPLUS_PAGES 只能是 auto \/ number \/ sequence/);
});

test('meta 里没有的话、放错层级的稿、不像 LabelPlus 的文件、坐标出界：一次全列出来', { timeout: 60_000 }, async (t) => {
  const data = await setup(t);
  await putDraft(data, 'sample/vol09/c099', C003);
  await putDraft(data, 'sample/misplaced', C003);
  await putDraft(data, 'zeta/v1/ch1', '这不是翻译稿\n');
  await putDraft(data, 'sample/vol01/c002', header + block('1.jpg', label(1, 0.5, -0.1, 1, 'x')) + '\n');

  const r = run({ DATA_DIR: data });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /meta 里没有 sample\/vol09\/c099 这一话/);
  assert.match(r.out, /raw\/labelplus\/sample\/misplaced\.txt：原始稿必须放在/);
  assert.match(r.out, /raw\/labelplus\/zeta\/v1\/ch1\.txt：没有任何文件块/);
  assert.match(r.out, /raw\/labelplus\/sample\/vol01\/c002\.txt pages\.0\.boxes\.0\.y/);
  assert.match(r.out, /错误 4 条/);
  assert.ok(!existsSync(join(data, 'text', 'sample', 'vol09')));
});

test('没有 raw 目录时什么都不做、退出码 0', { timeout: 60_000 }, async (t) => {
  const data = await setup(t);
  const r = run({ DATA_DIR: data });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /原始稿 0 份，本次处理 0 份/);
});
