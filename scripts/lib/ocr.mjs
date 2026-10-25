// 可选 OCR：有界下载 → Tesseract TSV → 待校对稿；默认从不写 data/text。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CHAPTER_KEY_RE, normalizeText, parseChapterText } from '@gallery/core';
import { loadGallery } from './data.mjs';
import { DATA_DIR, OUT_DIR } from './paths.mjs';

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 20_000;
export const OCR_TIMEOUT_MS = 120_000;
const TSV_COLUMNS = 'level page_num block_num par_num line_num word_num left top width height conf text'.split(' ');
const execute = promisify(execFile);
const exists = async (file) => {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const json = (value) => JSON.stringify(value, null, 2) + '\n';

/** OCR 不提供“空 = 全库”的隐式入口，以免一次识别所有图片。 */
export function requireOcrChapters(value) {
  const chapters = Array.isArray(value) ? value : String(value ?? '').split(',').map((key) => key.trim()).filter(Boolean);
  if (!chapters.length) throw new Error('OCR 必须显式设置 CHAPTERS，格式为 <series>/<issue>/<chapter>，多话用逗号分隔');
  for (const key of chapters) if (!CHAPTER_KEY_RE.test(key)) throw new Error(`无效 CHAPTERS：${key}`);
  return [...new Set(chapters)];
}

/** 汉字词元之间不插空格，英文单词仍保留分隔，标点不额外添空格。 */
export function joinOcrWords(words) {
  let text = '';
  for (const word of words) {
    const current = word.trim();
    if (!current) continue;
    const adjacentCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text) || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(current);
    const punctuation = /^[,.;:!?，。；：！？、）】》」』”’]/u.test(current) || /[（【《「『“‘(]$/u.test(text);
    text += (text && !adjacentCjk && !punctuation ? ' ' : '') + current;
  }
  return text;
}

/** TSV 的 level=5 是词，按页/块/段/行聚合；page 行核对实际图像尺寸。 */
export function tsvToBoxes(tsv, { width, height }) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) throw new Error('图片宽高必须为正整数');
  const rows = String(tsv ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (rows.shift()?.split('\t').join(' ') !== TSV_COLUMNS.join(' ')) throw new Error('OCR 未返回有效 TSV 表头');
  const lines = new Map();
  let pageSeen = false;
  let lowConfidence = 0;
  for (const [index, row] of rows.entries()) {
    if (!row.trim()) continue;
    const columns = row.split('\t');
    if (columns.length !== TSV_COLUMNS.length) throw new Error(`TSV 第 ${index + 2} 行字段数不正确`);
    const nums = columns.slice(0, 11).map(Number);
    if (nums.some((n) => !Number.isFinite(n)) || columns.slice(0, 11).some((n) => n.trim() === '')) throw new Error(`TSV 第 ${index + 2} 行含无效数字`);
    const [level, page, block, par, line, word, left, top, w, h, confidence] = nums;
    if (nums.slice(0, 10).some((n) => !Number.isSafeInteger(n) || n < 0) || level < 1 || level > 5 || page !== 1) throw new Error(`TSV 第 ${index + 2} 行层级或坐标不正确`);
    if (left + w > width || top + h > height || confidence < -1 || confidence > 100) throw new Error(`TSV 第 ${index + 2} 行坐标越界或置信度不正确`);
    if (level === 1) {
      if (pageSeen || left !== 0 || top !== 0 || w !== width || h !== height) throw new Error('OCR 图像尺寸与元数据不一致或包含多页');
      pageSeen = true;
    }
    if (level !== 5 || !columns[11].trim()) continue;
    if (!block || !par || !line || !word || !w || !h) throw new Error(`TSV 第 ${index + 2} 行缺少文字行位置`);
    const key = [page, block, par, line].join(':');
    if (!lines.has(key)) lines.set(key, []);
    const words = lines.get(key);
    if (words.some((entry) => entry.word === word)) throw new Error(`TSV 第 ${index + 2} 行词序号重复`);
    words.push({ word, left, top, right: left + w, bottom: top + h, text: columns[11] });
    if (confidence < 60) lowConfidence++;
  }
  if (!pageSeen) throw new Error('TSV 缺少图像尺寸行，不能确认输入图像');
  const boxes = [...lines.values()].map((words, i) => {
    words.sort((a, b) => a.word - b.word);
    const left = Math.min(...words.map((word) => word.left));
    const top = Math.min(...words.map((word) => word.top));
    const right = Math.max(...words.map((word) => word.right));
    const bottom = Math.max(...words.map((word) => word.bottom));
    const t = joinOcrWords(words.map((word) => word.text));
    return { i, x: left / width, y: top / height, w: (right - left) / width, h: (bottom - top) / height, t, tn: normalizeText(t) };
  });
  return { boxes, lowConfidence };
}

/** 子进程不经 shell；单页时限和输出上限独立于下载时限。 */
export async function runTesseract(args) {
  try {
    return await execute('tesseract', args, { encoding: 'utf8', timeout: OCR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未安装 tesseract；请先安装可选 OCR 引擎及 chi_sim、eng 语言包', { cause: error });
    if (error.killed || error.code === 'ETIMEDOUT') throw new Error('单页 OCR 超时，请缩小本次处理范围或检查图像', { cause: error });
    throw new Error(`tesseract 识别失败：${String(error.stderr || error.message).slice(0, 800)}`, { cause: error });
  }
}

export async function ensureTesseract(run = runTesseract) {
  let result;
  try { result = await run(['--list-langs']); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('未安装 tesseract；请先安装可选 OCR 引擎及 chi_sim、eng 语言包', { cause: error });
    throw error;
  }
  const languages = new Set(`${result.stdout}\n${result.stderr || ''}`.split(/\r?\n/).map((line) => line.trim()));
  const missing = ['chi_sim', 'eng'].filter((language) => !languages.has(language));
  if (missing.length) throw new Error(`tesseract 缺少语言包：${missing.join('、')}`);
}

/** 配置的多源依次尝试，流式限额也防没有或伪造 Content-Length 的响应。 */
export async function downloadOcrImage({ hosts, key, expectedHash, fetchImpl = fetch, maxBytes = IMAGE_MAX_BYTES, timeoutMs = IMAGE_TIMEOUT_MS }) {
  if (!Array.isArray(hosts) || !hosts.length) throw new Error('未配置图片来源');
  const problems = [];
  for (let index = 0; index < hosts.length; index++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('图片下载超时')), timeoutMs);
    try {
      const base = hosts[index].includes('://') ? hosts[index] : `https://${hosts[index]}`;
      const response = await fetchImpl(`${base.replace(/\/$/, '')}/${key}`, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('图片超过大小上限');
      if (!response.body) throw new Error('图片响应为空');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('图片超过大小上限');
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, size);
      if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('响应不是 WebP 图片');
      if (expectedHash && createHash('sha256').update(bytes).digest('hex').slice(0, 12) !== expectedHash) throw new Error('图片摘要与元数据不一致');
      return bytes;
    } catch (error) {
      problems.push(`来源 ${index + 1}：${controller.signal.aborted ? '下载超时或已中止' : error.message}`);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  throw new Error(`图片下载失败（${problems.join('；')}）`);
}

const htmlEscape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

/** 预览用相对图片路径，压缩包解开后可离线核对，无外部脚本。 */
export function renderOcrReview(text, chapter) {
  const name = chapter.key.split('/').at(-1);
  const pages = text.pages.map((page) => {
    const meta = chapter.pages.find((candidate) => candidate.n === page.n);
    const boxes = page.boxes.map((box) => `<span class="box" style="left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%" title="${htmlEscape(box.t)}">${box.i}</span>`).join('');
    const lines = page.boxes.map((box) => `<li><b>${box.i}</b> ${htmlEscape(box.t)}</li>`).join('');
    return `<section><h2>第 ${page.n} 页</h2><div class="frame"><img src="${name}.images/${page.n}.webp" width="${meta.w}" height="${meta.h}" alt="第 ${page.n} 页" loading="lazy">${boxes}</div><ol>${lines}</ol>${page.boxes.length ? '' : '<p>未识别到文字，请核对是否漏识别。</p>'}</section>`;
  }).join('\n');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCR 待校对稿</title><style>body{max-width:60rem;margin:auto;padding:1rem;font:16px/1.6 system-ui}.frame{position:relative}.frame img{display:block;width:100%;height:auto}.box{position:absolute;border:2px solid #d20;color:#900;background:#fff5;font-weight:bold}li{white-space:pre-wrap}section{margin:2rem 0}</style><h1>${htmlEscape(chapter.title)}：待校对</h1><p>这份 OCR 草稿尚未纳入文字层或检索。请对照图片核对文字、漏字、顺序与框位置，编辑同名 JSON 的 t 与坐标；tn 会在导入时重算。</p><p>校对完成后把 JSON 放入 data/raw/ocr 对应章节路径，再显式运行 --accept-reviewed。请保留所有页，空白页使用 boxes: []。</p>${pages}</html>\n`;
}

export function validateReviewedText(raw, chapter) {
  const text = parseChapterText(raw, { source: chapter.key });
  if (text.chapter !== chapter.key) throw new Error('校对稿 chapter 与所选章节不一致');
  const actualPages = new Set(text.pages.map((page) => page.n));
  if (actualPages.size !== chapter.pages.length || chapter.pages.some((page) => !actualPages.has(page.n))) throw new Error('校对稿页码必须与元数据完全一致；空白页保留 boxes: []');
  text.pages.sort((a, b) => a.n - b.n);
  for (const page of text.pages) for (const box of page.boxes) box.tn = normalizeText(box.t);
  return text;
}

async function writeReviewReport(reviewDir, result) {
  await mkdir(reviewDir, { recursive: true });
  await writeFile(join(reviewDir, 'report.json'), json(result));
  const notes = [
    'OCR 校对产物（未纳入文字层或检索）',
    `本次新草稿 ${result.drafts.length} 话；已有文本跳过 ${result.skipped.length} 话；错误 ${result.errors.length} 条。`,
    '草稿 JSON 与同名 HTML、images 目录应一起保留；请按 HTML 中的说明校对，再显式接受已校对稿。',
    '本次处理明细见 report.json；全跳过时没有新草稿，这是正常结果。',
    ...result.warnings.map((message) => `提示：${message}`),
    ...result.errors.map((message) => `错误：${message}`),
  ];
  await writeFile(join(reviewDir, 'README.txt'), notes.join('\n') + '\n');
}

export async function ingestOcr({ dataDir = DATA_DIR, outDir = OUT_DIR, chapters, config, acceptReviewed = false, fetchImpl = fetch, run = runTesseract } = {}) {
  const selected = requireOcrChapters(chapters);
  const gallery = await loadGallery({ dataDir, imagePrefix: config?.images?.prefix || 'img/' });
  const byKey = new Map(gallery.chapters.map((chapter) => [chapter.key, chapter]));
  for (const key of selected) if (!byKey.has(key)) throw new Error(`元数据中没有章节：${key}`);
  const result = { drafts: [], accepted: [], skipped: [], warnings: [], errors: [] };
  const todo = selected.map((key) => byKey.get(key)).filter((chapter) => {
    if (!chapter.hasText) return true;
    result.skipped.push(chapter.key);
    return false;
  });
  const reviewDir = join(outDir, 'ocr-review');
  if (!todo.length) {
    if (!acceptReviewed) await writeReviewReport(reviewDir, result);
    return result;
  }
  // 缺引擎/语言包在任何网络与写文件之前失败。
  if (!acceptReviewed) await ensureTesseract(run);
  for (const chapter of todo) {
    try {
      const parts = chapter.key.split('/');
      if (acceptReviewed) {
        const file = join(dataDir, 'raw', 'ocr', ...parts) + '.json';
        const text = validateReviewedText(JSON.parse(await readFile(file, 'utf8')), chapter);
        const target = join(dataDir, 'text', ...parts) + '.json';
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, json(text), { flag: 'wx' });
        result.accepted.push(chapter.key);
        continue;
      }
      const draft = join(reviewDir, ...parts) + '.json';
      if (await exists(draft)) {
        result.warnings.push(`${chapter.key}：已有待校对草稿，保留原文件；需要重做时先另存或删除该草稿`);
        continue;
      }
      const imageDir = join(reviewDir, ...parts) + '.images';
      await mkdir(imageDir, { recursive: true });
      const pages = [];
      for (const page of chapter.pages) {
        const image = await downloadOcrImage({ hosts: config?.images?.hosts, key: page.keys.webp, expectedHash: page.img, fetchImpl });
        const imageFile = join(imageDir, `${page.n}.webp`);
        await writeFile(imageFile, image);
        const { stdout } = await run([imageFile, '-', '-l', 'chi_sim+eng', '--psm', '11', 'tsv']);
        const { boxes, lowConfidence } = tsvToBoxes(stdout, { width: page.w, height: page.h });
        pages.push({ n: page.n, boxes });
        if (!boxes.length) result.warnings.push(`${chapter.key} 第 ${page.n} 页未识别到文字，请人工核对`);
        if (lowConfidence) result.warnings.push(`${chapter.key} 第 ${page.n} 页有 ${lowConfidence} 个低置信度词，请重点核对`);
      }
      const text = parseChapterText({ chapter: chapter.key, pages });
      await writeFile(draft.replace(/\.json$/, '.html'), renderOcrReview(text, chapter));
      await writeFile(draft, json(text), { flag: 'wx' });
      result.drafts.push(chapter.key);
    } catch (error) { result.errors.push(`${chapter.key}：${error.message}`); }
  }
  if (!acceptReviewed) await writeReviewReport(reviewDir, result);
  return result;
}
