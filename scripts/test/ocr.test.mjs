import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  requireOcrChapters, joinOcrWords, tsvToBoxes, ensureTesseract,
  downloadOcrImage, renderOcrReview, validateReviewedText, ingestOcr,
} from '../lib/ocr.mjs';

const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const image = Buffer.from('RIFF\x08\x00\x00\x00WEBPtest');
const hash = createHash('sha256').update(image).digest('hex').slice(0, 12);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const chapterKey = 'sample/v/c';
const config = { images: { prefix: 'img/', hosts: ['first.invalid', 'second.invalid'] } };
const word = (overrides = {}) => ({ level: 5, page: 1, block: 1, par: 1, line: 1, word: 1, left: 10, top: 20, width: 20, height: 10, confidence: 95, text: '漫画', ...overrides });
const wordRow = (w) => [w.level, w.page, w.block, w.par, w.line, w.word, w.left, w.top, w.width, w.height, w.confidence, w.text].join('\t');
function tsv(words = [word()], { width = 100, height = 200 } = {}) {
  return [HEADER, `1\t1\t0\t0\t0\t0\t0\t0\t${width}\t${height}\t-1\t`, ...words.map(wordRow)].join('\n') + '\n';
}

async function fixture(t, { existing = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gallery-ocr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const outDir = join(root, 'out');
  await mkdir(join(dataDir, 'meta'), { recursive: true });
  const meta = { id: 'sample', title: '测试作品', issues: [{ id: 'v', number: 1, title: '第一卷', chapters: [{ id: 'c', number: 1, title: '测试章节', pages: [{ n: 1, img: hash, w: 100, h: 200 }] }] }] };
  await writeFile(join(dataDir, 'meta', 'sample.yaml'), JSON.stringify(meta));
  const text = { chapter: chapterKey, pages: [{ n: 1, boxes: [{ i: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, t: '漫画', tn: '漫画' }] }] };
  const textPath = join(dataDir, 'text', 'sample', 'v', 'c.json');
  if (existing) { await mkdir(dirname(textPath), { recursive: true }); await writeFile(textPath, JSON.stringify(text)); }
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { stdout: args[0] === '--list-langs' ? 'List of available languages (2):\nchi_sim\neng\n' : tsv(), stderr: '' };
  };
  const opts = { dataDir, outDir, config, chapters: [chapterKey], fetchImpl: async () => new Response(image), run };
  return { ...opts, opts, text, textPath, calls, draftPath: join(outDir, 'ocr-review', 'sample', 'v', 'c.json') };
}

test('OCR 选话必须显式非空，拒绝路径穿越并去重', () => {
  assert.throws(() => requireOcrChapters(''), /必须显式/);
  assert.throws(() => requireOcrChapters([]), /必须显式/);
  assert.throws(() => requireOcrChapters('../v/c'), /无效/);
  assert.throws(() => requireOcrChapters('s/v/c,d/v/../../x'), /无效/);
  assert.deepEqual(requireOcrChapters(' sample/v/c, sample/v/c, '), [chapterKey]);
});

test('中文词元相接，英文分词保留空格，标点不多添空格', () => {
  assert.equal(joinOcrWords(['漫画', '作者', '的', '契約', '，', 'Hello', 'world', '!']), '漫画作者的契約， Hello world!');
  assert.equal(joinOcrWords(['「', '漫画', '作者', '」']), '「漫画作者」');
  assert.equal(joinOcrWords(['Hello', 'world']), 'Hello world');
});

test('TSV 按完整行标识聚合词，按词序排序并合并归一化坐标', () => {
  const result = tsvToBoxes(tsv([
    word({ word: 2, left: 35, top: 25, width: 10, text: '契約', confidence: 30 }),
    word({ text: '作者' }),
    word({ block: 2, text: 'Hello' }),
    word({ block: 2, word: 2, left: 35, text: 'world' }),
  ]), { width: 100, height: 200 });
  assert.deepEqual(result.boxes[0], { i: 0, x: 0.1, y: 0.1, w: 0.35, h: 0.075, t: '作者契約', tn: '作者契约' });
  assert.equal(result.boxes[1].t, 'Hello world');
  assert.equal(result.boxes[1].i, 1);
  assert.equal(result.lowConfidence, 1);
});

test('TSV 拒绝空响应、坏格式、尺寸漂移、越界、重复词与多页', () => {
  const options = { width: 100, height: 200 };
  for (const invalid of ['', HEADER, 'text\nabc', tsv().replace('95\t', 'NaN\t'), tsv([word({ left: -1 })]), tsv([word({ left: 99 })]), tsv([word(), word()]), tsv([word({ page: 2 })]), tsv([], { width: 101, height: 200 })]) {
    assert.throws(() => tsvToBoxes(invalid, options));
  }
  assert.deepEqual(tsvToBoxes(tsv([]), options), { boxes: [], lowConfidence: 0 });
});

test('缺引擎或缺中文语言包会报错，不伪装成功', async () => {
  await assert.rejects(ensureTesseract(async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }), /未安装 tesseract/);
  await assert.rejects(ensureTesseract(async () => ({ stdout: 'eng\n' })), /chi_sim/);
  await ensureTesseract(async () => ({ stdout: 'chi_sim\neng\n' }));
});

test('下载失败会切换配置来源，验证实际字节摘要', async () => {
  const calls = [];
  const downloaded = await downloadOcrImage({ hosts: config.images.hosts, key: 'img/test.webp', expectedHash: hash, fetchImpl: async (url) => {
    calls.push(url);
    return calls.length === 1 ? new Response('unavailable', { status: 503 }) : new Response(image);
  } });
  assert.deepEqual(downloaded, image);
  assert.deepEqual(calls, ['https://first.invalid/img/test.webp', 'https://second.invalid/img/test.webp']);
  await assert.rejects(downloadOcrImage({ hosts: ['first.invalid'], key: 'img/test.webp', expectedHash: '000000000000', fetchImpl: async () => new Response(image) }), /摘要/);
});

test('下载的声明长度和实收长度都受限，超时或非图片响应不能继续识别', async () => {
  const options = { hosts: ['first.invalid'], key: 'img/test.webp', maxBytes: 15 };
  await assert.rejects(downloadOcrImage({ ...options, fetchImpl: async () => new Response(image, { headers: { 'content-length': '99' } }) }), /大小上限/);
  await assert.rejects(downloadOcrImage({ ...options, fetchImpl: async () => new Response(image) }), /大小上限/);
  await assert.rejects(downloadOcrImage({ ...options, maxBytes: 100, fetchImpl: async () => new Response('<html>error</html>') }), /WebP/);
  await assert.rejects(downloadOcrImage({ ...options, timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) }), /超时/);
});

test('OCR 默认只产离线校对稿，执行 TSV 命令，不写 data/text', async (t) => {
  const f = await fixture(t);
  const result = await ingestOcr(f.opts);
  assert.deepEqual(result.drafts, [chapterKey]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.errors, []);
  await assert.rejects(access(f.textPath));
  const draft = JSON.parse(await readFile(f.draftPath, 'utf8'));
  assert.equal(draft.pages[0].boxes[0].t, '漫画');
  const html = await readFile(f.draftPath.replace(/\.json$/, '.html'), 'utf8');
  assert.match(html, /未纳入文字层或检索/);
  assert.match(html, /src="c.images\/1.webp"/);
  assert.deepEqual(await readFile(join(dirname(f.draftPath), 'c.images', '1.webp')), image);
  assert.deepEqual(f.calls[1].slice(1), ['-', '-l', 'chi_sim+eng', '--psm', '11', 'tsv']);
  // 已有草稿可能正在被校对，不覆盖。
  await writeFile(f.draftPath, '人工修改中的稿');
  const again = await ingestOcr(f.opts);
  assert.equal(again.drafts.length, 0);
  assert.match(again.warnings[0], /保留原文件/);
  assert.equal(await readFile(f.draftPath, 'utf8'), '人工修改中的稿');
});

test('已有文本直接跳过，未知章节与缺依赖在网络前失败', async (t) => {
  const existing = await fixture(t, { existing: true });
  const forbidden = async () => { assert.fail('不应下载或调用引擎'); };
  const result = await ingestOcr({ ...existing.opts, fetchImpl: forbidden, run: forbidden });
  assert.deepEqual(result.skipped, [chapterKey]);
  const reportDir = join(existing.outDir, 'ocr-review');
  const report = JSON.parse(await readFile(join(reportDir, 'report.json'), 'utf8'));
  assert.deepEqual(report.skipped, [chapterKey]);
  assert.equal(report.drafts.length, 0);
  assert.match(await readFile(join(reportDir, 'README.txt'), 'utf8'), /全跳过时没有新草稿/);
  await assert.rejects(ingestOcr({ ...existing.opts, chapters: ['sample/v/missing'], fetchImpl: forbidden, run: forbidden }), /没有章节/);
  const missing = await fixture(t);
  await assert.rejects(ingestOcr({ ...missing.opts, fetchImpl: forbidden, run: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), /未安装/);
});

test('引擎空输出不产生可误导的 JSON 成品，空白页明确提示待核对', async (t) => {
  const f = await fixture(t);
  const empty = await ingestOcr({ ...f.opts, run: async (args) => args[0] === '--list-langs' ? { stdout: 'chi_sim\neng' } : { stdout: '' } });
  assert.equal(empty.drafts.length, 0);
  assert.match(empty.errors[0], /TSV/);
  await assert.rejects(access(f.draftPath));
  const report = JSON.parse(await readFile(join(f.outDir, 'ocr-review', 'report.json'), 'utf8'));
  assert.equal(report.errors.length, 1);
  const blank = await ingestOcr({ ...f.opts, run: async (args) => args[0] === '--list-langs' ? { stdout: 'chi_sim\neng' } : { stdout: tsv([]) } });
  assert.equal(blank.drafts.length, 1);
  assert.match(blank.warnings[0], /未识别到文字/);
});

test('接受校对稿必须显式选择 raw/ocr 来源，重新归一化且不覆盖已有文本', async (t) => {
  const f = await fixture(t);
  await ingestOcr(f.opts);
  // out 中有草稿也不会自动接受。
  const missing = await ingestOcr({ ...f.opts, acceptReviewed: true });
  assert.equal(missing.accepted.length, 0);
  assert.equal(missing.errors.length, 1);
  await assert.rejects(access(f.textPath));
  const reviewed = structuredClone(f.text);
  reviewed.pages[0].boxes[0].t = '契約！';
  reviewed.pages[0].boxes[0].tn = '旧归一化';
  const raw = join(f.dataDir, 'raw', 'ocr', 'sample', 'v', 'c.json');
  await mkdir(dirname(raw), { recursive: true });
  await writeFile(raw, JSON.stringify(reviewed));
  const forbidden = async () => { assert.fail('接受已校对稿无需下载或引擎'); };
  const accepted = await ingestOcr({ ...f.opts, acceptReviewed: true, run: forbidden, fetchImpl: forbidden });
  assert.deepEqual(accepted.accepted, [chapterKey]);
  const saved = JSON.parse(await readFile(f.textPath, 'utf8'));
  assert.equal(saved.pages[0].boxes[0].tn, '契约');
  const again = await ingestOcr({ ...f.opts, acceptReviewed: true, run: forbidden, fetchImpl: forbidden });
  assert.deepEqual(again.skipped, [chapterKey]);
});

test('校对稿核对章节、所有页与 bbox；预览转义识别文字和标题', () => {
  const chapter = { key: chapterKey, title: '<script>alert(1)</script>', pages: [{ n: 1, w: 100, h: 200 }] };
  const text = { chapter: chapterKey, pages: [{ n: 1, boxes: [{ i: 0, x: 0, y: 0, w: 1, h: 1, t: '<img onerror="x">', tn: '' }] }] };
  assert.throws(() => validateReviewedText({ ...text, chapter: 'other/v/c' }, chapter), /不一致/);
  assert.throws(() => validateReviewedText({ ...text, pages: [] }, chapter), /页码/);
  const bad = structuredClone(text);
  bad.pages[0].boxes[0].x = 0.5;
  assert.throws(() => validateReviewedText(bad, chapter), /超出页面/);
  const html = renderOcrReview(text, chapter);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img onerror=&quot;x&quot;&gt;/);
});

test('OCR CLI 没有 CHAPTERS 必须非零退出，不能沿用占位成功', () => {
  const result = spawnSync(process.execPath, ['scripts/ingest-ocr.mjs'], { cwd: ROOT, env: { ...process.env, CHAPTERS: '' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /必须显式设置 CHAPTERS/);
});
