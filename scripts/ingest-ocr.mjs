#!/usr/bin/env node
// 手动 OCR 只产待校对稿；只有显式接受已校对来源时才写 data/text。
import { ingestOcr, requireOcrChapters } from './lib/ocr.mjs';
import { loadSiteConfig } from './lib/config.mjs';
import { DATA_DIR, OUT_DIR } from './lib/paths.mjs';
import { step, ok, warn, fail, note } from './lib/log.mjs';

step('ingest:ocr');
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--accept-reviewed') || args.length > 1) {
    throw new Error('用法：设置 CHAPTERS 后运行 ingest:ocr；仅支持可选参数 --accept-reviewed');
  }
  const chapters = requireOcrChapters(process.env.CHAPTERS);
  const result = await ingestOcr({
    dataDir: DATA_DIR,
    outDir: OUT_DIR,
    chapters,
    config: await loadSiteConfig(),
    acceptReviewed: args.includes('--accept-reviewed'),
  });
  for (const message of result.warnings) warn(message);
  for (const key of result.skipped) note(`${key}：已有文本，跳过`);
  for (const key of result.drafts) ok(`${key}：已生成待校对 JSON 与 HTML`);
  for (const key of result.accepted) ok(`${key}：已导入已校对稿`);
  for (const message of result.errors) fail(message);
  note(`待校对草稿 ${result.drafts.length} 话，导入 ${result.accepted.length} 话，跳过 ${result.skipped.length} 话`);
  if (!args.includes('--accept-reviewed')) note('OCR 草稿未纳入检索。请校对后放入 data/raw/ocr，再显式 --accept-reviewed 导入。');
  if (result.errors.length) process.exitCode = 1;
} catch (error) {
  fail(error.message);
  process.exitCode = 1;
}
