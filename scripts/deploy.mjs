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
// EdgeOne 的项目定位有两层（scripts/lib/edgeone.mjs）：
//   · EDGEONE_PROJECT_ID 是权威定位：部署前用 Pages API 按 ID 核对名字、按名字核对同名唯一性，
//     任何不一致都拒绝部署（一个字节都不传）；
//   · CLI 的 `-n` 只接受项目名（源码里按 Name 过滤取第一个，同名项目并存时会发错），
//     EDGEONE_PROJECT_NAME 只是「已核对过的名字」；把 ID 塞进 -n 会静默新建同名项目。
//   交给 CLI 的环境也不原样透传：EDGEONE_PROJECT_ID / EDGEONE_API_REGION 等被 unsetEnv 删掉，
//   token 只经 EDGEONE_PAGES_API_TOKEN 一个口子给。
//
// 首次真实部署要人验证的点：给一个已 build 好的目录时 CLI 是否只上传不再自行 build；
// dist 里的 edgeone.json 是否被识别；EDGEONE_API_REGION 与 token 的签发区域是否一致。
import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdtemp, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { TARGETS, GITHUB_BASELINE_FILES, planDeployCommand, checkGithubBaseline } from './lib/deploy-plan.mjs';
import { verifyEdgeoneProject } from './lib/edgeone.mjs';
import { waitForGithubPagesBuild } from './lib/github-pages-ready.mjs';
import { readManifest } from './lib/manifest.mjs';
import { releasePlan, releaseFingerprint, deploymentReceipt } from './lib/release.mjs';
import { DIST_DIR, OUT_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, fail, note } from './lib/log.mjs';

const show = (p) => (p.startsWith(ROOT + sep) ? relative(ROOT, p).split(sep).join('/') : p);
/** 预期中的配置错误：说清楚就退，不打栈——栈只会把手机上的日志推出屏幕。 */
const bail = (msg) => {
  fail(msg);
  process.exit(1);
};

async function deploymentInput(target, environment) {
  await rm(join(OUT_DIR, `deployed-${target}.json`), { force: true });
  const manifest = await readManifest(OUT_DIR);
  if (!manifest?.db || (process.env.RELEASE_VERSION && manifest.version !== process.env.RELEASE_VERSION)) {
    throw new Error('缺少本次完整构建的发布清单，请先运行 build');
  }
  const marker = JSON.parse(await readFile(join(DIST_DIR, 'release.json'), 'utf8'));
  if (marker.version !== manifest.version || marker.fingerprint !== releaseFingerprint(manifest) || marker.environment !== environment) {
    throw new Error('dist 与发布清单不属于同一次构建或部署环境不符，拒绝部署');
  }
  return deploymentReceipt(manifest, target, environment);
}

async function recordDeployment(receipt) {
  await writeFile(join(OUT_DIR, `deployed-${receipt.target}.json`), JSON.stringify(receipt) + '\n');
}

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
      return { pushed: false, commit: git(['rev-parse', 'HEAD']).trim() };
    }
    const message = version ? `chore(pages): 发布 ${version}` : 'chore(pages): 发布';
    git(['-c', 'user.name=cnb', '-c', 'user.email=cnb@cnb.cool', 'commit', '--quiet', '-m', message]);
    git(['push', '--force', 'origin', 'gh-pages']);
    return { pushed: true, commit: git(['rev-parse', 'HEAD']).trim() };
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
  const environment = process.env.DEPLOY_ENV || 'production';
  releasePlan({ target, environment, domain: config.site.domain, imageHosts: config.images.hosts });
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
    const receipt = await deploymentInput(target, environment);
    const { pushed, commit } = await pushGithubPages({ repo, token, version: receipt.version });
    await waitForGithubPagesBuild({ repo, token, commit, onProgress: note });
    await recordDeployment(receipt);
    ok(pushed ? `已推送 ${show(DIST_DIR)} → ${repo} 的 gh-pages 分支，Pages 构建已成功` : `${summary}；gh-pages 内容未变，Pages 构建已确认`);
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

  const receipt = await deploymentInput(target, environment);

  // EdgeOne：CLI 的 -n 只认名字，而 EdgeOne 允许多个同名项目。部署前按项目 ID 校验名字、
  // 按名字校验同名唯一性；任何不一致都拒绝部署（一个字节都不传）。
  if (target === 'edgeone') {
    const problems = await verifyEdgeoneProject({
      token: process.env.EDGEONE_API_TOKEN,
      region: process.env.EDGEONE_API_REGION,
      baseUrl: process.env.EDGEONE_API_BASE_URL,
      projectId: process.env.EDGEONE_PROJECT_ID,
      projectName: process.env.EDGEONE_PROJECT_NAME,
    });
    if (problems.length) {
      for (const p of problems) fail(p);
      fail('EdgeOne 项目校验未通过：拒绝部署（一个字节都没传）');
      process.exit(1);
    }
    note(`EdgeOne 项目校验通过：${process.env.EDGEONE_PROJECT_NAME}（${process.env.EDGEONE_PROJECT_ID}）`);
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
  await recordDeployment(receipt);
  ok(`deploy:${target} 完成`);
} catch (e) {
  fail(e.message);
  if (!e.issues) console.error(e.stack);
  process.exit(1);
}
