import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  parseLabelPlus,
  labelPlusToChapterText,
  pageByNumberInName,
  pageBySequence,
  choosePageOf,
} from '../src/labelplus.js';
import { parseChapterText } from '../src/schema.js';

const fixture = (name) => readFile(fileURLToPath(new URL(`./fixtures/labelplus/${name}`, import.meta.url)), 'utf8');
const BOM = String.fromCodePoint(0xfeff);

test('正常样本：文件头、三个文件块、标签数、坐标、多行文本', async () => {
  const doc = parseLabelPlus(await fixture('basic.txt'));
  assert.equal(doc.version, '1,0');
  assert.deepEqual(doc.groups, ['框内', '框外']);
  assert.equal(doc.comment, 'Default Comment\nYou can edit me');
  assert.deepEqual(doc.files.map((f) => [f.name, f.labels.length]), [['001.jpg', 2], ['002.jpg', 1], ['003.jpg', 0]]);
  const [a, b] = doc.files[0].labels;
  assert.deepEqual(a, { n: 1, x: 0.12, y: 0.08, kind: 1, text: '你好，世界！' });
  assert.equal(b.n, 2);
  assert.equal(b.kind, 2);
  assert.equal(b.text, '漫画作者的契約\n第二行', '保留中间换行，去掉末尾空行');
  assert.equal(doc.files[1].labels[0].text, '……');
  assert.deepEqual(doc.warnings, [], '规范导出没有任何可疑行');
});

test('CRLF + BOM 样本与 LF 样本解析结果完全一致', async () => {
  // CRLF + BOM 的样本在内存里现造，不放磁盘：仓库的 .gitattributes 把所有文本钉成 LF，
  // 一份 CRLF 样本提交后克隆出来就不再是 CRLF，名不副实还得加例外
  const lf = await fixture('basic.txt');
  const expected = parseLabelPlus(lf);
  const crlfBom = BOM + lf.replace(/\n/g, '\r\n');
  assert.ok(crlfBom.includes('\r\n') && crlfBom.startsWith(BOM));
  const doc = parseLabelPlus(crlfBom);
  assert.deepEqual(doc, expected);
  for (const f of doc.files) for (const l of f.labels) assert.ok(!l.text.includes('\r'), '文本里不残留 \\r');
});

test('边角样本：无备注、编号不连续、空文件块、标签后紧跟文件块、像分隔符的行是台词、同页两个文件', async () => {
  const doc = parseLabelPlus(await fixture('edge.txt'));
  assert.equal(doc.version, '1,0');
  assert.deepEqual(doc.groups, ['框内']);
  assert.equal(doc.comment, '');
  assert.deepEqual(doc.files.map((f) => f.name), ['cover.jpg', 'p01.png', 'x', 'p01-b.png']);
  assert.deepEqual(doc.files[0].labels, [], '没有标签的文件块');
  const p01 = doc.files[1].labels;
  assert.deepEqual(
    p01.map((l) => [l.n, l.text]),
    [[3, '第一个文件'], [5, '']],
    '编号不连续照收；标签后紧跟文件块 → 空文本',
  );
  const x = doc.files[2].labels;
  assert.deepEqual(x.map((l) => l.n), [7, 9]);
  assert.equal(x[0].text, '', '只有空白行的标签文本为空');
  assert.deepEqual([x[0].x, x[0].y], [0.5, 1], '.5 与 1 这种写法也认');
  // 7 个 > 的行、缺坐标的 ---- 行、15 个 - 的行、全角破折号：全是台词，不是分隔符
  assert.equal(
    x[1].text,
    '>>>>>>>[y]<<<<<<<\n----------------[9]----------------\n---------------[9]---------------[0.5,0.5,1]\n————————————————\n最后一条',
  );
  assert.ok(!doc.files.some((f) => f.name === 'y'));
  assert.equal(doc.files[3].labels[0].text, '同一页的第二个文件');
  // 只有 16 个 - 却缺坐标的那一行以标签前缀开头：行为是当台词保留，但要报出来给人看
  assert.equal(doc.warnings.length, 1, doc.warnings.join('\n'));
  assert.match(doc.warnings[0], /^第 16 行：像分隔符但不完全匹配，已当作台词保留：「----------------\[9\]----------------」$/);
});

test('可疑行都进 warnings：逗号后带空格的标签、文件块头下无处可挂的行、文件头里的分隔符', () => {
  // 真实导出稍有出入（逗号后多个空格）时，标签 1 与它的台词会无声消失——这正是要响的地方
  const lost = parseLabelPlus(
    '>>>>>>>>[001.jpg]<<<<<<<<\n' +
      '----------------[1]----------------[0.5, 0.5, 1]\n这句台词去哪了\n' +
      '----------------[2]----------------[0.5,0.5,1]\n还在\n',
  );
  assert.deepEqual(
    lost.files[0].labels.map((l) => [l.n, l.text]),
    [[2, '还在']],
    '行为不变：对不上就不是标签',
  );
  assert.deepEqual(lost.warnings, [
    '第 2 行：像分隔符但不完全匹配，不在任何标签下、已丢弃：「----------------[1]----------------[0.5, 0.5, 1]」',
    '第 2 行起：文件块「001.jpg」头与第一个标签之间有 2 行内容，没有标签可挂、已丢弃：「----------------[1]----------------[0.5, 0.5, 1]」',
  ]);
  // 9 个 > 的行落在标签文本里：保留为台词，同样报出来；预览截到 60 字
  const inLabel = parseLabelPlus(
    '>>>>>>>>[1.jpg]<<<<<<<<\n----------------[1]----------------[0.5,0.5,1]\n' + '>'.repeat(9) + '[x]' + '<'.repeat(50) + '\n',
  );
  assert.equal(inLabel.files[0].labels[0].text, '>'.repeat(9) + '[x]' + '<'.repeat(50));
  assert.equal(inLabel.warnings.length, 1);
  assert.match(inLabel.warnings[0], /^第 3 行：像分隔符但不完全匹配，已当作台词保留：「>{9}\[x\]<{48}…」$/);
  // 文件头 / 备注里出现分隔符前缀：整份稿可能被吞进备注，更要响
  const inHeader = parseLabelPlus(
    '1,0\n-\n框内\n-\n>>>>>>>>[001.jpg]<<<<<<<< 多了尾巴\n----------------[1]----------------[0.5,0.5,1]\nhi\n',
  );
  assert.deepEqual(inHeader.files, []);
  assert.deepEqual(
    inHeader.warnings.map((w) => w.slice(0, 31)),
    ['第 5 行：像分隔符但不完全匹配，落在文件头 / 备注里：「>', '第 6 行：像分隔符但不完全匹配，落在文件头 / 备注里：「-'],
  );
});

test('缺整个文件头、空文件、只有文件头都不报错', () => {
  const noHeader = parseLabelPlus('>>>>>>>>[001.jpg]<<<<<<<<\n----------------[1]----------------[0.5,0.5,1]\nhi\n');
  assert.deepEqual([noHeader.version, noHeader.groups, noHeader.comment], ['', [], '']);
  assert.equal(noHeader.files[0].labels[0].text, 'hi');
  assert.deepEqual(parseLabelPlus(''), { version: '', groups: [], comment: '', files: [], warnings: [] });
  assert.deepEqual(parseLabelPlus('1,0\n-\n框内\n-\n'), {
    version: '1,0',
    groups: ['框内'],
    comment: '',
    files: [],
    warnings: [],
  });
  // 文件块头与第一个标签之间的行没处放，丢弃；不会变成标签或文件，但会报出来
  const stray = parseLabelPlus(
    '>>>>>>>>[1.jpg]<<<<<<<<\n杂行\n>>>>>>>[假]<<<<<<<\n----------------[1]----------------[0.5,0.5,1]\nhi\n',
  );
  assert.deepEqual(stray.files.map((f) => [f.name, f.labels.map((l) => l.text)]), [['1.jpg', ['hi']]]);
  assert.deepEqual(stray.warnings, ['第 2 行起：文件块「1.jpg」头与第一个标签之间有 2 行内容，没有标签可挂、已丢弃：「杂行」']);
  assert.throws(() => parseLabelPlus(null), TypeError);
});

test('页码策略：文件名里第一段数字 / 按顺序 / 默认整份二选一', () => {
  assert.equal(pageByNumberInName('001.jpg', 5), 1);
  assert.equal(pageByNumberInName('page_012.png', 0), 12);
  assert.equal(pageByNumberInName('cover.jpg', 0), null);
  assert.equal(pageBySequence('cover.jpg', 0), 1);
  assert.equal(pageBySequence('whatever', 4), 5);
  assert.equal(choosePageOf([{ name: '1.jpg' }, { name: '02.jpg' }]), pageByNumberInName);
  assert.equal(choosePageOf([{ name: 'cover.jpg' }, { name: '02.jpg' }]), pageBySequence, '有一个没数字就整份按顺序');
  assert.equal(choosePageOf([]), pageByNumberInName);
});

test('转 ChapterText：默认按文件名数字，w=h=0，i 按页内顺序，过 schema，键顺序稳定', async () => {
  const text = labelPlusToChapterText(parseLabelPlus(await fixture('basic.txt')), { chapter: 'sample/vol01/c001' });
  assert.deepEqual(parseChapterText(text), text, '输出本身能再过一遍 schema');
  assert.equal(text.chapter, 'sample/vol01/c001');
  assert.deepEqual(text.pages.map((p) => p.n), [1, 2, 3]);
  assert.deepEqual(text.pages[0].boxes, [
    { i: 0, x: 0.12, y: 0.08, w: 0, h: 0, t: '你好，世界！', tn: '你好世界' },
    { i: 1, x: 0.55, y: 0.4, w: 0, h: 0, t: '漫画作者的契約\n第二行', tn: '漫画作者的契约第二行' },
  ]);
  assert.deepEqual(text.pages[1].boxes, [{ i: 0, x: 0.3, y: 0.5, w: 0, h: 0, t: '……', tn: '' }]);
  assert.deepEqual(text.pages[2].boxes, [], '没有标签的文件块也算一页');
  assert.deepEqual(Object.keys(text), ['chapter', 'pages']);
  assert.deepEqual(Object.keys(text.pages[0]), ['n', 'boxes']);
  assert.deepEqual(Object.keys(text.pages[0].boxes[0]), ['i', 'x', 'y', 'w', 'h', 't', 'tn']);
});

test('转 ChapterText：边角样本整份按顺序；显式策略下同页合并、空文本跳过', async () => {
  const doc = parseLabelPlus(await fixture('edge.txt'));
  // cover.jpg 没有数字 → 默认整份按顺序：cover=1, p01=2, x=3, p01-b=4
  const seq = labelPlusToChapterText(doc, { chapter: 'a/b/c' });
  assert.deepEqual(seq.pages.map((p) => [p.n, p.boxes.length]), [[1, 0], [2, 1], [3, 1], [4, 1]]);
  assert.equal(seq.pages[1].boxes[0].t, '第一个文件');
  assert.ok(seq.pages[2].boxes[0].t.startsWith('>>>>>>>[y]<<<<<<<\n'));
  // 归一化后只剩字母数字与汉字：y、9、9、0.5,0.5,1 的数字、最后一条
  assert.equal(seq.pages[2].boxes[0].tn, 'y9905051最后一条', '像分隔符的台词也照常归一化');
  // 显式给策略：p01 与 p01-b 都是 1，合并到同一页，i 接着编；没数字的落到 50+序号
  const merged = labelPlusToChapterText(doc, {
    chapter: 'a/b/c',
    pageOf: (name, i) => pageByNumberInName(name, i) ?? 50 + i,
  });
  assert.deepEqual(merged.pages.map((p) => p.n), [1, 50, 52]);
  assert.deepEqual(merged.pages[0].boxes.map((b) => [b.i, b.t]), [[0, '第一个文件'], [1, '同一页的第二个文件']]);
  assert.deepEqual(parseChapterText(merged), merged);
});

test('转 ChapterText：页码非正整数、chapter 缺失、坐标出界都报错且说清是哪个文件', () => {
  const doc = parseLabelPlus('>>>>>>>>[000.jpg]<<<<<<<<\n>>>>>>>>[001.jpg]<<<<<<<<\n');
  assert.throws(() => labelPlusToChapterText(doc, { chapter: 'a/b/c' }), /「000\.jpg」.*页码是 0/);
  assert.throws(() => labelPlusToChapterText(doc, { chapter: 'a/b/c', pageOf: () => 1.5 }), /1\.5/);
  assert.throws(() => labelPlusToChapterText(doc, { chapter: 'a/b/c', pageOf: () => null }), /null/);
  assert.throws(() => labelPlusToChapterText(doc, {}), TypeError);
  const fine = parseLabelPlus('>>>>>>>>[1.jpg]<<<<<<<<\n');
  assert.throws(() => labelPlusToChapterText(fine, { chapter: 'bad key' }), /<series>\/<issue>\/<chapter>/);
  const out = parseLabelPlus('>>>>>>>>[1.jpg]<<<<<<<<\n----------------[1]----------------[1.2,-0.1,1]\nx\n');
  assert.throws(() => labelPlusToChapterText(out, { chapter: 'a/b/c', source: 'draft.txt' }), (e) => {
    assert.match(e.message, /draft\.txt/);
    assert.match(e.message, /pages\.0\.boxes\.0\.x/);
    return true;
  });
});
