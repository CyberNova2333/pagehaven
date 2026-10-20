#!/usr/bin/env node
// ingest:labelplus —— data/raw/labelplus/<series>/<issue>/<chapter>.txt → data/text/<series>/<issue>/<chapter>.json
// （ARCHITECTURE §4「LabelPlus 解析」、§5）。薄入口：实现在 lib/ingest-labelplus.mjs，便于测试直接 import。
//
// 环境变量：
//   CHAPTERS         逗号分隔的 <series>/<issue>/<chapter>（发布流水线的 chapters 输入）；空 = 全部有原始稿的话
//   LABELPLUS_PAGES  页码策略：auto（默认：文件名全带数字按数字，否则按顺序）| number | sequence
//   DATA_DIR         数据目录（见 lib/paths.mjs）
// 有任何错误就以 1 退出，但会先把所有错误列全；没出错的话照常写出。提示（⚠）不影响退出码：
// CHAPTERS 里没有稿的话、解析器的可疑行、raw 目录里的非 .txt 文件都只是提示。
import { ingestLabelPlus, parseChaptersEnv } from './lib/ingest-labelplus.mjs';
import { DATA_DIR } from './lib/paths.mjs';
import { step, ok, fail, warn, note } from './lib/log.mjs';

step('ingest:labelplus');
note(`DATA_DIR=${DATA_DIR}`);
const result = await ingestLabelPlus({
  dataDir: DATA_DIR,
  chapters: parseChaptersEnv(process.env.CHAPTERS),
  pageStrategy: process.env.LABELPLUS_PAGES || 'auto',
});

console.log('');
for (const w of result.warnings) warn(w);
for (const e of result.errors) fail(e);
console.log('');
const { written, unchanged, warnings, errors } = result;
note(`写出 ${written.length} 话，未变 ${unchanged.length} 话，提示 ${warnings.length} 条，错误 ${errors.length} 条`);
if (errors.length) {
  fail('ingest:labelplus：有错误，见上');
  process.exit(1);
}
ok('ingest:labelplus：完成');
