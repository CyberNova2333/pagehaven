#!/usr/bin/env node
// 无需完整构建即可检查正式内容；只读，不生成产物或访问图片来源。
import { checkData, failedDataReport } from './lib/check-data.mjs';
import { DATA_DIR } from './lib/paths.mjs';
import { step, ok, fail, note, warn } from './lib/log.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const unknown = args.filter((arg) => !['--json', '--help'].includes(arg));
let report;
if (unknown.length) {
  report = failedDataReport(DATA_DIR, [`未知参数：${unknown.join('、')}；使用 --help 查看用法`]);
} else if (args.includes('--help')) {
  console.log(`用法：pnpm run check:data -- [--json] [--help]

检查 data/meta 与 data/text 的格式和对应关系，汇总台词稿与可检索文字覆盖情况。
DATA_DIR 可指定其他现有数据目录；空目录有效，不存在的目录会报错。
缺少台词稿或稿内没有可检索文字仅作提示。命令只读，无需构建、云配置或网络。
--json  输出结构化报告；有校验或参数错误时退出码为 1。
--help  显示用法。`);
  process.exit(0);
} else {
  report = await checkData({ dataDir: DATA_DIR });
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  step('check:data');
  note(`DATA_DIR=${report.dataDir}`);
  if (report.ok) {
    const totals = report.totals;
    const coverage = report.coverage;
    note(`${totals.series} 个作品、${totals.issues} 期、${totals.chapters} 话、${totals.pages} 页、${totals.boxes} 个台词框`);
    if (totals.chapters === 0) {
      note('尚无章节，暂不计算台词覆盖率。');
    } else {
      note(`台词稿 ${coverage.withText} / ${totals.chapters} 话；有可检索文字 ${coverage.searchableChapters} 话、${coverage.searchablePages} 页、${coverage.searchableBoxes} 个框`);
      for (const key of report.missingText) warn(`${key}：尚无台词稿`);
      for (const key of report.emptyText) warn(`${key}：已有台词稿，尚无可检索文字`);
    }
    ok('check:data：内容检查通过');
  } else {
    for (const issue of report.issues) fail(issue);
    fail(`check:data：共 ${report.issues.length} 处错误`);
  }
}
process.exitCode = report.ok ? 0 : 1;
