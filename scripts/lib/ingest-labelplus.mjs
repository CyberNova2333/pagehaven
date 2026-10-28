// ingest:labelplus 的实现：data/raw/labelplus 里的 LabelPlus 稿 → data/text 的一话 JSON（ARCHITECTURE §4、§5）。
//
// 约定：原始稿放在 DATA_DIR/raw/labelplus/<series>/<issue>/<chapter>.txt——路径本身就是 chapter key，
// 维护者在手机上用 GitHub 网页把文件传到这个位置就算「交稿」，不需要任何别的登记。
// 输出 DATA_DIR/text/<series>/<issue>/<chapter>.json，2 空格缩进、键顺序固定（schema 的顺序），
// 内容没变就不重写——这样 发布流水线写回仓库的 diff 只有真正改过的话。
//
// 核对是这一步唯一的「判断」：稿里的页码超出 meta 的页数是错（页码策略选错、或 meta 没更新），
// meta 里有页而稿里没有只是提示（那页本来就没台词很常见），meta 里没有这一话是错（先补 meta）。
// CHAPTERS 里列了、却没有原始稿的话要分两种：meta 里有这一话 → 只提示（发布流水线的 ocr 输入
// 就是给「没有 LabelPlus 稿的话」用的，ingest:ocr 在本步之后拿同一份 CHAPTERS 跑，这里报错等于把 OCR
// 那条路整个堵死）；meta 里也没有 → 错（大概率是拼错了）。
// 所有错误攒到一起再返回，不在第一处停：维护者是在手机上翻构建日志，来回改一条报一条太折磨。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { CHAPTER_KEY_RE } from '@gallery/core';
import { parseLabelPlus, labelPlusToChapterText, pageByNumberInName, pageBySequence } from '@gallery/core/labelplus';
import { loadGallery } from './data.mjs';
import { DATA_DIR } from './paths.mjs';
import * as defaultLog from './log.mjs';

/** 页码策略名 → 策略；auto 交给 labelPlusToChapterText 的默认（全带数字按数字，否则按顺序）。 */
export const PAGE_STRATEGIES = { auto: undefined, number: pageByNumberInName, sequence: pageBySequence };

/** @param {string} dataDir */
export function rawLabelPlusDir(dataDir) {
  return join(dataDir, 'raw', 'labelplus');
}

/** @param {string} dataDir @param {string} key  <series>/<issue>/<chapter> */
export function textFileFor(dataDir, key) {
  return join(dataDir, 'text', ...key.split('/')) + '.json';
}

/** CHAPTERS 环境变量（发布流水线的 chapters 输入）：逗号分隔，容忍空白与空项。 */
export function parseChaptersEnv(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 一话的 JSON 文本：2 空格缩进、末尾换行。键顺序由 schema 决定，输入无关，便于 diff。 */
export function serializeChapterText(text) {
  return JSON.stringify(text, null, 2) + '\n';
}

async function walk(dir, out = []) {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

/**
 * 找出全部原始稿：只认 <series>/<issue>/<chapter>.txt 这一层的 .txt（扩展名不分大小写，手机上传
 * 的文件名常常是 .TXT）。放错层级的 .txt 是错误，README 与点文件之外的其它文件是提示——
 * 悄悄忽略的话，维护者会以为交了稿却什么都没发生。
 * @returns {Promise<{drafts: Map<string, string>, conflicts: Set<string>, warnings: string[], errors: string[]}>}
 */
async function findDrafts(dataDir) {
  const rawDir = rawLabelPlusDir(dataDir);
  const drafts = new Map();
  const candidates = new Map();
  const conflicts = new Set();
  const warnings = [];
  const errors = [];
  const rel = (p) => relative(dataDir, p).split(sep).join('/');
  for (const file of (await walk(rawDir)).sort()) {
    const name = basename(file);
    if (/^readme/i.test(name) || name.startsWith('.')) continue;
    if (!/\.txt$/i.test(name)) {
      warnings.push(`${rel(file)}：不是 .txt，已忽略（LabelPlus 稿只认 .txt；不是稿就删掉它）`);
      continue;
    }
    const parts = relative(rawDir, file).split(sep);
    const key = parts.join('/').replace(/\.txt$/i, '');
    if (parts.length !== 3 || !CHAPTER_KEY_RE.test(key)) {
      errors.push(`${rel(file)}：原始稿必须放在 raw/labelplus/<series>/<issue>/<chapter>.txt（小写字母数字连字符）`);
      continue;
    }
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(file);
  }
  for (const [key, files] of candidates) {
    if (files.length > 1) {
      conflicts.add(key);
      errors.push(`${key}：同一话有多份原始稿，无法选择，请只保留一份：${files.map(rel).join('、')}`);
    } else drafts.set(key, files[0]);
  }
  return { drafts, conflicts, warnings, errors };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {string[]} [opts.chapters]  限定处理的话（chapter key）；空 = 全部有原始稿的话
 * @param {'auto'|'number'|'sequence'} [opts.pageStrategy]
 * @param {boolean} [opts.dryRun]  只生成计划与诊断，不创建目录或写文件
 * @param {typeof defaultLog} [opts.log]
 * @returns {Promise<{written: string[], unchanged: string[], planned: {chapter: string, action: 'create'|'update'}[], warnings: string[], errors: string[]}>}
 */
export async function ingestLabelPlus(opts = {}) {
  const { dataDir = DATA_DIR, chapters = [], pageStrategy = 'auto', dryRun = false, log = defaultLog } = opts;
  const written = [];
  const unchanged = [];
  const planned = [];
  const warnings = [];
  const errors = [];
  const rel = (p) => relative(dataDir, p).split(sep).join('/');

  // hasOwn 而不是 in：'toString' in {} 也为真，那样校验形同虚设
  if (!Object.hasOwn(PAGE_STRATEGIES, pageStrategy)) {
    errors.push(`LABELPLUS_PAGES 只能是 ${Object.keys(PAGE_STRATEGIES).join(' / ')}，现在是「${pageStrategy}」`);
    return { written, unchanged, planned, warnings, errors };
  }
  const pageOf = PAGE_STRATEGIES[pageStrategy];

  // ── 1. 找稿 ──
  const found = await findDrafts(dataDir);
  warnings.push(...found.warnings);
  errors.push(...found.errors);

  // ── 2. 读 meta：CHAPTERS 的过滤要用它区分「拼错了」与「本来就没稿」，核对也要用 ──
  let gallery;
  try {
    gallery = await loadGallery({ dataDir });
  } catch (e) {
    errors.push(...(e.issues ?? [e.message]));
    errors.push('data/ 现有内容不合法，无法与 meta 核对，本次不写任何文件');
    return { written, unchanged, planned, warnings, errors };
  }
  const byKey = new Map(gallery.chapters.map((c) => [c.key, c]));

  // ── 3. 按 CHAPTERS 过滤 ──
  /** @type {Map<string, string>} */
  let todo = found.drafts;
  if (chapters.length) {
    todo = new Map();
    for (const key of chapters) {
      if (!CHAPTER_KEY_RE.test(key)) {
        errors.push(`CHAPTERS 里的「${key}」不是 <series>/<issue>/<chapter>`);
        continue;
      }
      if (found.conflicts.has(key)) continue;
      if (found.drafts.has(key)) {
        todo.set(key, found.drafts.get(key));
        continue;
      }
      const expected = rel(join(rawLabelPlusDir(dataDir), ...key.split('/')) + '.txt');
      if (byKey.has(key)) {
        warnings.push(`CHAPTERS 里的 ${key} 没有 LabelPlus 稿（${expected} 不存在），跳过；要补它的台词请开 ocr`);
      } else {
        errors.push(`CHAPTERS 里的 ${key}：meta 里没有这一话，也没有原始稿（${expected}）——是不是拼错了`);
      }
    }
  }
  log.note(`原始稿 ${found.drafts.size} 份，本次处理 ${todo.size} 份${chapters.length ? '（CHAPTERS 限定）' : ''}`);

  // ── 4. 解析、转换（先把格式问题全找出来，再去对 meta）──
  /** @type {Map<string, import('@gallery/core').ChapterText>} */
  const texts = new Map();
  for (const [key, file] of todo) {
    let doc;
    try {
      doc = parseLabelPlus(await readFile(file, 'utf8'));
    } catch (e) {
      errors.push(`${rel(file)}：读取或解析失败：${e.message}`);
      continue;
    }
    // 解析器的可疑行：行为没变（保留 / 丢弃），但真实导出稍有出入时台词会无声消失，必须有人看见
    warnings.push(...doc.warnings.map((w) => `${rel(file)}：${w}`));
    if (doc.files.length === 0) {
      errors.push(`${rel(file)}：没有任何文件块（>>>>>>>>[文件名]<<<<<<<<），这不是 LabelPlus 翻译稿？`);
      continue;
    }
    try {
      texts.set(key, labelPlusToChapterText(doc, { chapter: key, pageOf, source: rel(file) }));
    } catch (e) {
      errors.push(...(e.issues ?? [e.message]));
    }
  }

  // ── 5. 逐话核对；预览与实际导入共用计划，只在实际导入时写出 ──
  for (const [key, text] of texts) {
    const file = todo.get(key);
    const chapter = byKey.get(key);
    if (!chapter) {
      errors.push(`${rel(file)}：meta 里没有 ${key} 这一话——先在 data/meta/${key.split('/')[0]}.yaml 里补上`);
      continue;
    }
    const pageCount = chapter.pages.length;
    const beyond = text.pages.filter((p) => p.n > pageCount).map((p) => p.n);
    if (beyond.length) {
      errors.push(
        `${rel(file)}：稿里有第 ${beyond.join('、')} 页，但 meta 里 ${key} 只有 ${pageCount} 页` +
          '（文件名里的数字不是页码？可试 LABELPLUS_PAGES=sequence；或 meta 少了页）',
      );
      continue;
    }
    const present = new Set(text.pages.map((p) => p.n));
    const missing = [];
    for (let n = 1; n <= pageCount; n += 1) if (!present.has(n)) missing.push(n);
    if (missing.length) {
      warnings.push(`${key}：meta 里的第 ${missing.join('、')} 页在稿里没有对应文件块（没台词的页很正常，只是提示）`);
    }

    const out = textFileFor(dataDir, key);
    const content = serializeChapterText(text);
    const exists = existsSync(out);
    if (exists && (await readFile(out, 'utf8')) === content) {
      unchanged.push(key);
      log.note(`${key}：内容未变，不重写`);
      continue;
    }
    const action = exists ? 'update' : 'create';
    planned.push({ chapter: key, action });
    if (dryRun) {
      log.note(`将${action === 'create' ? '新增' : '更新'} ${key} → ${rel(out)}`);
      continue;
    }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, content);
    written.push(key);
    const boxes = text.pages.reduce((n, p) => n + p.boxes.length, 0);
    log.ok(`${key} → ${rel(out)}（${text.pages.length} 页、${boxes} 个框）`);
  }
  return { written, unchanged, planned, warnings, errors };
}
