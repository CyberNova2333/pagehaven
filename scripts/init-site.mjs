#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, OUT_DIR } from './lib/paths.mjs';
import { parseInitArgs, planInit, readInitConfig, say, SETUP_TARGETS, writeInitConfig } from './lib/init-site.mjs';

function help(locale) {
  console.log(say(locale, '页间 · 站点初始化', 'Pagehaven · Site setup'));
  console.log(say(locale, 'pnpm run init                         交互配置（需要终端）', 'pnpm run init                         Interactive setup (terminal required)'));
  console.log(say(locale, 'pnpm run init -- [参数]                默认仅预览；加 --write 写入', 'pnpm run init -- [options]             Preview by default; add --write to save'));
  console.log(say(locale, `
--title <名称>                       站点名称
--domain <域名>                      站点主机名，不含协议、路径
--image-host <域名>                  图片主机名，可重复，最多两项
--target <目标>                      none | cloudflare | edgeone | github | workers | esa；仅配置引导
--project <名称>                     Cloudflare Pages 项目名
--site-lang <语言>                   HTML 语言标记，不翻译网站界面
--text-layer <true|false>            文字层
--enhanced-reader <true|false>       可选增强分页
--platform-config <true|false>      平台配置文件
--config <路径>                     配置文件；也支持 CONFIG_FILE
--ui-lang <zh|en>                   初始化界面语言，默认中文
--dry-run                          仅预览
--write                            校验、备份后写入配置
--help                             显示帮助
`, `
--title <name>                       Site title
--domain <hostname>                  Site hostname, without protocol or path
--image-host <hostname>              Repeat for up to two image hosts
--target <target>                    none | cloudflare | edgeone | github | workers | esa; setup guidance only
--project <name>                     Cloudflare Pages project name
--site-lang <language>               HTML language tag; does not translate the website
--text-layer <true|false>            Text overlays
--enhanced-reader <true|false>       Optional enhanced pagination
--platform-config <true|false>      Platform configuration files
--config <path>                     Configuration file; also accepts CONFIG_FILE
--ui-lang <zh|en>                   Setup interface language, Chinese by default
--dry-run                          Preview only
--write                            Validate, back up, and save configuration
--help                             Show help
`));
}

function summary(plan, file, locale) {
  console.log(say(locale, `配置：${file}`, `Configuration: ${file}`));
  for (const change of plan.changes) console.log(`  ${change.path}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
  if (!plan.changes.length) console.log(say(locale, '配置未变。', 'Configuration is unchanged.'));
  console.log(say(locale, `目标引导：${plan.target}；发布时仍需在 CNB 手动选择目标。`, `Setup guidance: ${plan.target}; choose the release target manually in CNB when publishing.`));
  if (plan.target === 'cloudflare') console.log(say(locale, '请准备对应的 Pages 项目，并在部署密钥中配置账号与令牌。', 'Prepare the matching Pages project and configure its account and token in deployment secrets.'));
  if (plan.target === 'edgeone') console.log(say(locale, '请在部署密钥中配置项目 ID、项目名、区域与令牌。', 'Configure the project ID, project name, region, and token in deployment secrets.'));
  if (plan.target === 'github') console.log(say(locale, '请在部署密钥中配置发布仓库与令牌，并将 Pages 来源设为 gh-pages 根目录。', 'Configure the publishing repository and token in deployment secrets, with Pages sourced from the gh-pages root.'));
  if (plan.target === 'workers') console.log(say(locale, '请在部署密钥中配置账号、令牌、独立生产和预览 Worker 名称及对应验证地址。', 'Configure the account, token, separate production and preview Worker names, and verification URLs in deployment secrets.'));
  if (plan.target === 'esa') console.log(say(locale, '请核对 ESA 套餐资格，在部署密钥中配置项目及验证地址；每个项目最多 2,000 个静态文件。', 'Check ESA plan eligibility and configure project credentials and verification URLs in deployment secrets; each project allows at most 2,000 static files.'));
  if (!plan.productionDomainsReady) console.log(say(locale, '当前示例域名可用于构建预览；生产发布前需更换站点及图片域名。', 'The current example domains support build previews; replace site and image hostnames before production deployment.'));
  console.log(say(locale, '初始化只编辑配置，不创建平台资源或发布站点。', 'Setup only edits configuration; it does not create hosted resources or deploy the site.'));
}

export async function main(args = process.argv.slice(2)) {
  const options = parseInitArgs(args);
  const { locale } = options;
  if (options.help) { help(locale); return; }
  if (options.interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(say(locale, '非交互环境请提供配置参数；使用 --help 查看选项，默认预览，加 --write 才写入。', 'Supply options in a non-interactive environment. Use --help; options preview by default and --write saves.'));
  }
  const file = resolve(options.config ?? (process.env.CONFIG_FILE || CONFIG_FILE));
  const original = await readFile(file, 'utf8');
  let plan;
  let shouldWrite = options.write;
  if (options.interactive) {
    const current = readInitConfig(original, locale);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    rl.on('SIGINT', cancel);
    rl.on('close', cancel);
    const ask = async (zh, en, fallback) => {
      const answer = await rl.question(`${say(locale, zh, en)} [${fallback}]: `, { signal: controller.signal });
      return answer.trim() || String(fallback);
    };
    try {
      console.log(say(locale, '按回车保留当前值；最后确认前不会写入。', 'Press Enter to keep a value; nothing is written before final confirmation.'));
      const target = await ask(`目标引导 (${SETUP_TARGETS.join('/')})`, `Setup guidance (${SETUP_TARGETS.join('/')})`, 'none');
      const edits = {
        title: await ask('站点名称', 'Site title', current.site.title),
        domain: await ask('站点域名（不含协议）', 'Site hostname (no protocol)', current.site.domain),
        'image-host': (await ask('图片域名（最多两个，逗号分隔）', 'Image hosts (up to two, comma-separated)', current.images.hosts.join(', '))).split(','),
        'site-lang': await ask('HTML 语言标记（不翻译界面）', 'HTML language tag (does not translate the UI)', current.site.lang),
        'text-layer': await ask('文字层 (true/false)', 'Text overlays (true/false)', current.features.text_layer),
        'enhanced-reader': await ask('增强分页 (true/false)', 'Enhanced pagination (true/false)', current.features.comimi_reader),
        'platform-config': await ask('平台配置文件 (true/false)', 'Platform configuration files (true/false)', current.features.platform_config),
      };
      if (target === 'cloudflare') edits.project = await ask('Pages 项目名', 'Pages project name', current.deploy.cloudflare.project);
      plan = planInit(original, edits, { locale, target });
      summary(plan, file, locale);
      shouldWrite = plan.changes.length > 0 && /^(y|yes)$/i.test(await ask('写入以上配置？(y/N)', 'Save this configuration? (y/N)', 'N'));
    } catch (error) {
      if (controller.signal.aborted || error.code === 'ABORT_ERR') { console.log(say(locale, '已取消，配置未写入。', 'Cancelled; configuration was not written.')); return; }
      throw error;
    } finally { rl.close(); }
  } else {
    plan = planInit(original, options.edits, options);
    summary(plan, file, locale);
  }
  if (!shouldWrite) {
    console.log(say(locale, '未写入配置。参数模式加 --write 可应用以上更改。', 'Configuration was not written. Add --write in option mode to apply these changes.'));
    return;
  }
  const saved = await writeInitConfig(file, original, plan.text, { backupDir: join(OUT_DIR, 'init'), locale });
  if (saved.changed) console.log(say(locale, `配置已更新。原文件备份：${saved.backup}`, `Configuration saved. Original backup: ${saved.backup}`));
  console.log(say(locale, '下一步运行 pnpm run build 刷新生成物，再运行 pnpm run check。', 'Next run pnpm run build to refresh generated files, then pnpm run check.'));
}

try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
