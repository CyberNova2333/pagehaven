// LabelPlus 翻译稿（.txt）解析器，以及从解析结果到 data/text 一话 JSON 的转换（ARCHITECTURE §4）。
//
// 文件长这样（版本 1,0）：
//
//   1,0                                            ← 版本行
//   -
//   框内                                           ← 分组名，每行一个
//   框外
//   -
//   备注（任意多行，直到第一个文件块；可以没有）
//   >>>>>>>>[001.jpg]<<<<<<<<                      ← 文件块：8 个 > 与 8 个 <
//   ----------------[1]----------------[0.527,0.122,1]   ← 标签：16 个 -，[编号]，[x,y,分组序号]
//   台词第一行
//   台词第二行
//                                                  ← 标签文本到下一个标签 / 文件块 / 文件尾为止
//   ----------------[2]----------------[0.226,0.318,2]
//   ……
//
// 解析器只做「把文件切成结构」这一件事，**不猜页码**：文件名到页码的映射是策略（pageOf），
// 由调用方选，内置两种在下面。分隔符只认完全匹配（个数、方括号一个不差），因为放宽一点
// 就会把台词里的装饰线「————」「>>>」当成分隔符吃掉——那种行就是台词，要原样保留。
// 容忍的东西：BOM、CRLF、标签编号不连续、没有标签的文件块、缺备注段、缺整个文件头。
//
// 但「容忍」不等于「不响」：以分隔符前缀开头却整行对不上的行（逗号后多了个空格之类），
// 以及文件块头与第一个标签之间无处可挂的行，都会静默地变成台词或被丢掉——真实导出稍有出入时
// 悄悄丢台词正是这个项目最忌讳的失败模式。所以解析结果带 warnings，把这些行连行号一起报出来，
// 由 ingest 打成 ⚠；行为本身不变（保留 / 丢弃），响不响是另一回事。
import { parseChapterText } from './schema.js';
import { normalizeText } from './normalize.js';

const FILE_RE = /^>{8}\[(.*)\]<{8}\s*$/;
// 坐标是 0–1 的小数；也接受「1」「.5」这种写法，负号留给 schema 去拒绝（那是数据问题，不是格式问题）
const NUM = '(-?(?:\\d+\\.?\\d*|\\.\\d+))';
const LABEL_RE = new RegExp(`^-{16}\\[(\\d+)\\]-{16}\\[${NUM},${NUM},(\\d+)\\]\\s*$`);
const VERSION_RE = /^\d+,\d+$/;
// 「像分隔符」的判据：与第三方解析器一致，按前缀看。前缀命中而整行不匹配，就是值得报出来的可疑行。
const SEPARATOR_PREFIX_RE = /^(?:>{8}|-{16}\[)/;
// 一行标签本身约 50 个字符，预览要能把整行标签放下，不然「逗号后多了个空格」正好被截掉看不见
const PREVIEW_CHARS = 60;

/**
 * @typedef {object} LabelPlusLabel
 * @property {number} n     标签编号（文件里写的，不保证连续）
 * @property {number} x     0–1
 * @property {number} y     0–1
 * @property {number} kind  分组序号（1 起，对应 groups 的下标 + 1）
 * @property {string} text  标签文本，保留中间换行，去掉末尾空行
 */
/**
 * @typedef {object} LabelPlusFile
 * @property {string} name  文件块头方括号里的文件名
 * @property {LabelPlusLabel[]} labels
 */
/**
 * @typedef {object} LabelPlusDoc
 * @property {string} version   版本行原文，如 '1,0'；没有则 ''
 * @property {string[]} groups  分组名
 * @property {string} comment   备注；没有则 ''
 * @property {LabelPlusFile[]} files  按出现顺序
 * @property {string[]} warnings  可疑但没有改变解析行为的地方（带 1 起的行号），给人看的
 */

/** 去掉数组末尾的空白行（只去末尾：中间的空行是台词分段，要留）。 */
function dropTrailingBlank(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(0, end);
}

/** 警告里引用的行内容：只取前几十个字，日志是在手机上看的。 */
function preview(line) {
  const chars = [...line.trim()];
  return chars.length > PREVIEW_CHARS ? chars.slice(0, PREVIEW_CHARS).join('') + '…' : chars.join('');
}

/** 文件头：版本行、两个 - 之间的分组名、其后到第一个文件块之前的备注。每一段都可以缺。 */
function parseHeader(lines) {
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  let version = '';
  if (i < lines.length && VERSION_RE.test(lines[i].trim())) {
    version = lines[i].trim();
    i += 1;
  }
  const groups = [];
  if (i < lines.length && lines[i].trim() === '-') {
    i += 1;
    while (i < lines.length && lines[i].trim() !== '-') {
      const g = lines[i].trim();
      if (g) groups.push(g);
      i += 1;
    }
    if (i < lines.length) i += 1; // 第二个 -
  }
  // 备注是自由文本，首尾空行都不算内容
  const rest = dropTrailingBlank(lines.slice(i));
  let start = 0;
  while (start < rest.length && rest[start].trim() === '') start += 1;
  return { version, groups, comment: rest.slice(start).join('\n') };
}

/**
 * @param {string} text  LabelPlus txt 的全文（任意换行、可带 BOM）
 * @returns {LabelPlusDoc}
 */
export function parseLabelPlus(text) {
  if (typeof text !== 'string') throw new TypeError('parseLabelPlus 只接受字符串');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const headerLines = [];
  /** @type {LabelPlusFile[]} */
  const files = [];
  /** @type {string[]} */
  const warnings = [];
  let file = null;
  let label = null; // { n, x, y, kind, lines }
  // 当前文件块头与第一个标签之间出现的非空行：[行号, 内容]，文件块结束时汇总成一条警告
  let stray = [];
  const flush = () => {
    if (label) {
      file.labels.push({
        n: label.n,
        x: label.x,
        y: label.y,
        kind: label.kind,
        text: dropTrailingBlank(label.lines).join('\n'),
      });
    }
    label = null;
  };
  const closeFile = () => {
    flush();
    if (stray.length) {
      warnings.push(
        `第 ${stray[0][0]} 行起：文件块「${file.name}」头与第一个标签之间有 ${stray.length} 行内容，` +
          `没有标签可挂、已丢弃：「${preview(stray[0][1])}」`,
      );
    }
    stray = [];
  };
  lines.forEach((line, index) => {
    const no = index + 1;
    const f = FILE_RE.exec(line);
    if (f) {
      if (file) closeFile();
      file = { name: f[1].trim(), labels: [] };
      files.push(file);
      return;
    }
    const l = file ? LABEL_RE.exec(line) : null;
    if (l) {
      flush();
      label = { n: Number(l[1]), x: Number(l[2]), y: Number(l[3]), kind: Number(l[4]), lines: [] };
      return;
    }
    if (SEPARATOR_PREFIX_RE.test(line)) {
      const fate = !file ? '落在文件头 / 备注里' : label ? '已当作台词保留' : '不在任何标签下、已丢弃';
      warnings.push(`第 ${no} 行：像分隔符但不完全匹配，${fate}：「${preview(line)}」`);
    }
    if (!file) headerLines.push(line);
    else if (label) label.lines.push(line);
    else if (line.trim() !== '') stray.push([no, line]);
  });
  if (file) closeFile();
  return { ...parseHeader(headerLines), files, warnings };
}

/**
 * 页码策略之一：文件名里第一段数字就是页码（001.jpg → 1，page_012.png → 12）。
 * 文件名没有数字时返回 null，交给调用方决定怎么办。
 * @param {string} name
 * @param {number} _index
 * @returns {number | null}
 */
export const pageByNumberInName = (name, _index) => {
  const m = /\d+/.exec(name);
  return m ? Number.parseInt(m[0], 10) : null;
};

/**
 * 页码策略之二：按文件块在稿里出现的顺序 1..N。
 * @param {string} _name
 * @param {number} index  0 起
 * @returns {number}
 */
export const pageBySequence = (_name, index) => index + 1;

/**
 * 默认策略：文件名全都带数字就按数字，否则整份稿按顺序。
 *
 * 为什么是整份稿二选一，而不是逐个文件「有数字用数字、没有就用顺序」：混用时
 * cover.jpg（顺序 → 1）与 001.jpg（数字 → 1）会静默合并到同一页，错了也看不出来；
 * 整份按顺序则要么对、要么页数对不上 meta 而被 ingest 报出来。宁可响，不要哑。
 * @param {LabelPlusFile[]} files
 * @returns {typeof pageByNumberInName | typeof pageBySequence}
 */
export function choosePageOf(files) {
  return files.every((f, i) => pageByNumberInName(f.name, i) !== null) ? pageByNumberInName : pageBySequence;
}

/**
 * 解析结果 → 符合 ChapterTextSchema 的一话台词。
 *
 * 每个标签一个框：x,y 取标签坐标，w=h=0（LabelPlus 的标签是点不是框，schema 允许 0），
 * t 保留换行，tn 走归一化，i 按标签在该页里的出现顺序从 0 起；空文本的标签跳过；
 * 多个文件落到同一页时合并（先出现的先编号）。没有标签的文件块也算一页（boxes 为空）——
 * 它的页码同样要算、同样要过核对，000.jpg 这种 0 起的编号才会在这里响而不是错位一整话。
 * @param {LabelPlusDoc} parsed
 * @param {object} opts
 * @param {string} opts.chapter  <series>/<issue>/<chapter>
 * @param {(name: string, index: number) => number | null | undefined} [opts.pageOf]  页码策略，缺省见 choosePageOf
 * @param {string} [opts.source]  报错时的来源标识（文件路径之类）
 * @returns {import('./schema.js').ChapterText}
 */
export function labelPlusToChapterText(parsed, { chapter, pageOf, source = '' } = {}) {
  if (typeof chapter !== 'string' || !chapter) {
    throw new TypeError('labelPlusToChapterText 需要 chapter（<series>/<issue>/<chapter>）');
  }
  const strategy = pageOf ?? choosePageOf(parsed.files);
  /** @type {Map<number, object[]>} */
  const pages = new Map();
  parsed.files.forEach((file, index) => {
    const n = strategy(file.name, index);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `${source ? source + ' ' : ''}文件块「${file.name}」（第 ${index + 1} 个）得到的页码是 ${n}，` +
          '页码必须是 ≥ 1 的整数；文件名里的数字不是页码时改用按顺序的策略（pageBySequence）',
      );
    }
    if (!pages.has(n)) pages.set(n, []);
    const boxes = pages.get(n);
    for (const label of file.labels) {
      if (label.text.trim() === '') continue;
      boxes.push({ i: boxes.length, x: label.x, y: label.y, w: 0, h: 0, t: label.text, tn: normalizeText(label.text) });
    }
  });
  const raw = {
    chapter,
    pages: [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([n, boxes]) => ({ n, boxes })),
  };
  return parseChapterText(raw, { source });
}
