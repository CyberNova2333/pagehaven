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

const args = process.argv.slice(2);
const unknown = args.find((arg) => !['--dry-run', '--help'].includes(arg));
if (unknown) {
  fail(`未知参数：${unknown}；使用 --help 查看用法`);
  process.exit(1);
}
if (args.includes('--help')) {
  console.log(`用法：npm run ingest:labelplus -- [--dry-run] [--help]

--dry-run  预览新增、更新、未变章节及全部诊断，不写入任何文件
--help     显示帮助

不带 --dry-run 时写入有效章节；其他章节出错时仍会保留这些写入，并以非零退出。
环境变量：DATA_DIR 指定数据目录，CHAPTERS 限定章节（逗号分隔），
LABELPLUS_PAGES=auto|number|sequence 选择页码策略。`);
  process.exit(0);
}
const dryRun = args.includes('--dry-run');
step('ingest:labelplus');
note(`DATA_DIR=${DATA_DIR}`);
if (dryRun) note('预览模式：不会创建目录或写入文件');
const result = await ingestLabelPlus({
  dataDir: DATA_DIR,
  chapters: parseChaptersEnv(process.env.CHAPTERS),
  pageStrategy: process.env.LABELPLUS_PAGES || 'auto',
  dryRun,
});

console.log('');
for (const w of result.warnings) warn(w);
for (const e of result.errors) fail(e);
console.log('');
const { written, unchanged, planned, warnings, errors } = result;
if (dryRun) {
  const created = planned.filter((change) => change.action === 'create').length;
  const updated = planned.filter((change) => change.action === 'update').length;
  note(`预览：新增 ${created} 话，更新 ${updated} 话，未变 ${unchanged.length} 话，提示 ${warnings.length} 条，错误 ${errors.length} 条`);
} else note(`写出 ${written.length} 话，未变 ${unchanged.length} 话，提示 ${warnings.length} 条，错误 ${errors.length} 条`);
if (errors.length) {
  fail('ingest:labelplus：有错误，见上');
  process.exit(1);
}
ok(`ingest:labelplus：${dryRun ? '预览完成' : '完成'}`);
