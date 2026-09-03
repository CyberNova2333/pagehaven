#!/usr/bin/env node
// deploy:<target> —— 把 dist 发到 cloudflare | edgeone | github（ARCHITECTURE §3 三平台矩阵）。
//
// 命令行与校验规则在 scripts/lib/deploy-plan.mjs（纯函数，有单测）；这里只读配置与环境、打印、执行。
//   · cloudflare / edgeone：起对应 CLI，stdio 直通——CLI 的报错原样透出，脚本不翻译也不吞；
//     DEPLOY_DRY_RUN=1 只打印命令（凭据打码）不执行；DEPLOY_ENV=preview 发预览（默认 production）。
//   · github：不上传（release.yml 用 upload-pages-artifact + deploy-pages），只校验 dist 里的基线文件。
// 只在 CI 里真跑；凭据缺失是配置错误，退出 1（铁律 7）。
//
// 交给 CLI 的环境不是原样透传：计划里 unsetEnv 列的变量会先删掉（EdgeOne 的 EDGEONE_PROJECT_ID /
// EDGEONE_API_TOKEN），再注入 env 里的（token 经 CLI 认的变量名给）。CLI 包里有把 EDGEONE_PROJECT_ID
// 当 ProjectId 读的路径，而我们那个 secret 放的是项目名——不让它拿到，项目只经 -n 一个口子指定。
//
// EdgeOne 首次真实部署要人验证的点（不对就改 deploy-plan.mjs）：`-n` 是「项目名，不存在就新建」，
// secret 填错不报错而是新建同名项目——先 DEPLOY_ENV=preview 看 CLI 打出的项目名与 URL；给一个已
// build 好的目录时 CLI 是否只上传不再自行 build；dist 里的 edgeone.json 是否被识别。
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { TARGETS, GITHUB_BASELINE_FILES, planDeployCommand, checkGithubBaseline } from './lib/deploy-plan.mjs';
import { DIST_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, fail, note } from './lib/log.mjs';

const show = (p) => (p.startsWith(ROOT + sep) ? relative(ROOT, p).split(sep).join('/') : p);
/** 预期中的配置错误：说清楚就退，不打栈——栈只会把手机上的日志推出屏幕。 */
const bail = (msg) => {
  fail(msg);
  process.exit(1);
};

const target = process.argv[2];
if (!TARGETS.includes(target)) {
  fail(`用法：node scripts/deploy.mjs <${TARGETS.join('|')}>`);
  process.exit(2);
}

step(`deploy:${target}`);
try {
  const config = await loadSiteConfig();
  if (!existsSync(DIST_DIR)) bail(`${show(DIST_DIR)} 不存在：先 npm run build`);

  if (target === 'github') {
    const files = {};
    for (const name of [...GITHUB_BASELINE_FILES, 'CNAME']) {
      const p = join(DIST_DIR, name);
      files[name] = existsSync(p) ? await readFile(p, 'utf8') : null;
    }
    const problems = checkGithubBaseline({ config, files });
    if (problems.length) {
      for (const p of problems) fail(p);
      process.exit(1);
    }
    ok(`${show(DIST_DIR)} 基线文件齐全：${GITHUB_BASELINE_FILES.join('、')}${config.deploy.github.cname ? `、CNAME=${config.site.domain}` : ''}；上传由 workflow 的 deploy-pages 完成`);
    process.exit(0);
  }

  const plan = planDeployCommand({ target, config, env: process.env, distDir: DIST_DIR });
  if (!plan.ok) {
    for (const p of plan.problems) fail(p);
    process.exit(1);
  }
  note(plan.display);
  if (process.env.DEPLOY_ENV === 'preview') note('DEPLOY_ENV=preview：发到预览环境，核对 CLI 打出的项目名与 URL 后再发 production');
  if (process.env.DEPLOY_DRY_RUN === '1') {
    ok('DEPLOY_DRY_RUN=1：只打印命令，不执行');
    process.exit(0);
  }

  const childEnv = { ...process.env };
  for (const k of plan.unsetEnv) delete childEnv[k];
  Object.assign(childEnv, plan.env);
  // 在 npm run 下用 npm 自己的入口（npm_execpath）起，行为与 PATH 无关；直接 node 跑脚本时退回 PATH 里的 npm
  const npmCli = process.env.npm_execpath;
  const opts = { cwd: ROOT, stdio: 'inherit', env: childEnv };
  const r = npmCli ? spawnSync(process.execPath, [npmCli, ...plan.npmArgs], opts) : spawnSync('npm', plan.npmArgs, opts);
  if (r.error) throw new Error(`起不来 npm：${r.error.message}`);
  if (r.status !== 0) {
    fail(`deploy:${target} 失败，CLI 退出码 ${r.status}（报错见上方 CLI 输出）`);
    process.exit(r.status ?? 1);
  }
  ok(`deploy:${target} 完成`);
} catch (e) {
  fail(e.message);
  if (!e.issues) console.error(e.stack);
  process.exit(1);
}
