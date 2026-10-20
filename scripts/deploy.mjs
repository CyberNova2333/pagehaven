#!/usr/bin/env node
// deploy:<target> —— 把 dist 发到 cloudflare | edgeone | github（ARCHITECTURE §3 三平台矩阵）。
//
// 命令行与校验规则在 scripts/lib/deploy-plan.mjs（纯函数，有单测）；这里只读配置与环境、打印、执行。
//   · cloudflare / edgeone：起对应 CLI，stdio 直通——CLI 的报错原样透出，脚本不翻译也不吞；
//     DEPLOY_DRY_RUN=1 只打印命令（凭据打码）不执行；DEPLOY_ENV=preview 发预览（默认 production）。
//   · github：先校验 dist 里的基线文件，再把 dist 推到 GITHUB_PAGES_REPO 的 gh-pages 分支
//     （GitHub Pages 从该分支发布）；凭据是 GITHUB_PAGES_REPO / GITHUB_PAGES_TOKEN，
//     只校验不上传用 DEPLOY_DRY_RUN=1。
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
import { readFile, readdir, mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * GitHub Pages 的发布：把 dist 原样推到 <repo> 的 gh-pages 分支。
 * 站点是纯产物、图片 key 带内容哈希（修图走「新 key + 重建」），分支历史没有价值，
 * 所以每次整份覆盖（--force）。GitHub Pages 在仓库设置里指向 gh-pages 即可。
 */
async function pushGithubPages({ repo, token, version }) {
  const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
  const scrub = (s) => (token ? String(s).split(token).join('***') : String(s));
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-gh-pages-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
    if (r.status !== 0) {
      const detail = ((r.stderr || '') + (r.stdout || '')).trim();
      throw new Error(scrub(`git ${args[0]} 失败（退出码 ${r.status ?? '起不来'}）：${detail}`));
    }
    return r.stdout || '';
  };
  try {
    const clone = spawnSync('git', ['clone', '--depth', '1', '--branch', 'gh-pages', remote, tmp], { encoding: 'utf8' });
    if (clone.status !== 0) {
      // gh-pages 还不存在（首次发布）：从空分支开始
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      git(['init', '--quiet']);
      git(['checkout', '--quiet', '-b', 'gh-pages']);
      git(['remote', 'add', 'origin', remote]);
    }
    // 清空工作树（保留 .git），再把 dist 的内容放到根上
    for (const name of await readdir(tmp)) {
      if (name !== '.git') await rm(join(tmp, name), { recursive: true, force: true });
    }
    for (const name of await readdir(DIST_DIR)) {
      await cp(join(DIST_DIR, name), join(tmp, name), { recursive: true });
    }
    git(['add', '-A']);
    if (!git(['status', '--porcelain']).trim()) {
      note('gh-pages 内容没有变化，不产生空提交');
      return false;
    }
    const message = version ? `chore(pages): 发布 ${version}` : 'chore(pages): 发布';
    git(['-c', 'user.name=cnb', '-c', 'user.email=cnb@cnb.cool', 'commit', '--quiet', '-m', message]);
    git(['push', '--force', 'origin', 'gh-pages']);
    return true;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

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
    const summary = `${show(DIST_DIR)} 基线文件齐全：${GITHUB_BASELINE_FILES.join('、')}${config.deploy.github.cname ? `、CNAME=${config.site.domain}` : ''}`;
    if (process.env.DEPLOY_DRY_RUN === '1') {
      ok(`${summary}；DEPLOY_DRY_RUN=1：只校验基线，不推 gh-pages`);
      process.exit(0);
    }
    const repo = process.env.GITHUB_PAGES_REPO;
    const token = process.env.GITHUB_PAGES_TOKEN;
    if (!repo || !token) {
      fail(
        `${summary}，但缺 GITHUB_PAGES_REPO / GITHUB_PAGES_TOKEN：GitHub Pages 由 CNB 流水线把 dist 推到该仓库的 gh-pages 分支（GitHub Pages 的发布源指到 gh-pages 即可）；只校验基线用 DEPLOY_DRY_RUN=1`,
      );
      process.exit(1);
    }
    const pushed = await pushGithubPages({ repo, token, version: process.env.RELEASE_VERSION });
    ok(pushed ? `已推送 ${show(DIST_DIR)} → ${repo} 的 gh-pages 分支` : `${summary}；gh-pages 内容未变，无需推送`);
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
