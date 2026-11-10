// 部署命令的拼装与 GitHub Pages 基线校验（纯函数）。
//
// deploy.mjs 只做三件事：读配置与环境、来这里换成「命令行或问题列表」、执行。凭据只从环境来
// （铁律 7），缺了就是配置错误——返回问题让脚本以非零退出，不能让 CLI 自己去交互式登录，
// 那在 CI 里只会挂住。命令行本身是文档约定（ARCHITECTURE §3 三平台矩阵），抽成纯函数是为了
// 能逐个参数单测，而不用真跑一次部署。
//
// 部署 CLI 通过 `pnpm --package=<包>@<版本> dlx <命令>` 临时拉取：它们只在发布时用一次，不值得
// 进 package.json 常驻；钉大版本是让「哪个 CLI」成为可复现的事实，而不是碰上什么装什么。
//
// 三个目标的差别（§3）：
//   · cloudflare：wrangler 从环境读 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，命令行只给项目名与目录；
//   · edgeone：CLI 的 CI 用法是 `makers deploy <目录> -n <项目名> -e production`；token 不走命令行参数
//     （进程参数对同机进程可见），而是经 CLI 认的 EDGEONE_PAGES_API_TOKEN 环境变量给——这是从 CLI 包里
//     查到的回退路径（`-t` 缺省时读该变量），README 没写，首次真实部署时验证；
//   · github：脚本先校验 dist 里的基线文件，再由 deploy.mjs 把 dist 推到 GITHUB_PAGES_REPO 的
//     gh-pages 分支（GitHub Pages 的发布源）——GitHub Pages 没有响应头、没有重定向，缺了这几个
//     文件站点就不完整（铁律 2）。
//
// EdgeOne 的 `-n` 只认项目名（EdgeOne 允许多个同名项目，CLI 按 Name 过滤取第一个）：
// 名字不是权威定位，部署前由 deploy.mjs 用 Pages API 按 EDGEONE_PROJECT_ID 核对名字与同名唯一性；
// 把项目 ID 塞进 -n 会被 CLI 当成名字，静默新建一个以那串字符为名的项目。
// 首次部署先 DEPLOY_ENV=preview、核对 CLI 输出的项目名与 URL，再切 production。
//
// DEPLOY_ENV（可选，production | preview，默认 production）：CONTRIBUTING §二.3 要求平台层改动先向
// preview 真实部署一次，这个开关就是给那一步用的。cloudflare 用 --branch 区分（等于项目的 production
// branch 才是生产，其它名字都是预览），edgeone 用 -e。

import { DEPLOY_TARGETS, isDeploymentName } from '@gallery/platform';
import { isIP } from 'node:net';
import { deploymentRoot } from './deploy-ready.mjs';

export const TARGETS = DEPLOY_TARGETS;
export const DEPLOY_ENVS = ['production', 'preview'];
export const WRANGLER_SPEC = 'wrangler@4';
export const EDGEONE_CLI_SPEC = 'edgeone@1';
// 此版本的官方 CLI 支持环境凭据和 --no-preview，防止预览访问令牌进入日志。
export const ESA_CLI_SPEC = 'esa-cli@1.0.13';
/** 没有这三个文件 GitHub Pages 就不完整：.nojekyll 防 _ 开头的路径被吞、404 页、首页。 */
export const GITHUB_BASELINE_FILES = ['.nojekyll', '404.html', 'index.html'];
/**
 * cloudflare 生产部署用的分支名。wrangler 只认「等于 Pages 项目的 production branch」为生产，所以项目的
 * production branch 必须是它（首次真实部署时验证：不是的话 CLI 照样退 0，只是发成了预览、URL 是 *.pages.dev）。
 */
export const CLOUDFLARE_PRODUCTION_BRANCH = 'main';
export const CLOUDFLARE_PREVIEW_BRANCH = 'preview';

const REQUIRED_ENV = {
  cloudflare: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
  // EdgeOne 三件套：ID 是权威定位（部署前由 lib/edgeone.mjs 校验），名字只是 CLI -n 的参数
  edgeone: ['EDGEONE_API_TOKEN', 'EDGEONE_PROJECT_ID', 'EDGEONE_PROJECT_NAME'],
  github: [],
  workers: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKER_NAME', 'WORKERS_DEPLOY_URL'],
  esa: ['ESA_ACCESS_KEY_ID', 'ESA_ACCESS_KEY_SECRET', 'ESA_PROJECT_NAME', 'ESA_DEPLOY_URL'],
};

/** 该目标必须有的环境变量（凭据）。 */
export function requiredEnv(target) {
  return [...(REQUIRED_ENV[target] ?? [])];
}

/**
 * @typedef {object} DeployCommand
 * @property {true} ok
 * @property {string[]} pnpmArgs   传给 pnpm 的参数（启动器区分脚本与原生程序）
 * @property {string} display     给日志看的命令行，凭据已打码
 * @property {Record<string, string>} env  执行时额外注入的环境变量
 * @property {string[]} unsetEnv  执行前要从继承的环境里删掉的变量：只经我们选定的通道交给 CLI，
 *   不让它顺手把 secrets 当别的东西再读一次
 */

/**
 * config + env → 部署命令行；缺凭据或目标不对 → 问题列表。
 * @param {{ target: string, config: import('@gallery/platform').SiteConfig, env: Record<string, string|undefined>, distDir: string }} input
 * @returns {DeployCommand | { ok: false, problems: string[] }}
 */
export function planDeployCommand({ target, config, env, distDir }) {
  if (target === 'github') {
    return { ok: false, problems: ['github 目标由 deploy.mjs 直接校验基线并推 gh-pages，不走这里拼 CLI 命令'] };
  }
  if (!REQUIRED_ENV[target]) {
    return { ok: false, problems: [`未知的部署目标 ${JSON.stringify(target)}，只认 ${TARGETS.join(' | ')}`] };
  }
  const missing = REQUIRED_ENV[target].filter((k) => !env[k]);
  if (missing.length) {
    return { ok: false, problems: [`缺少 ${missing.join('、')}（deploy:${target} 的凭据只从 secrets 来，缺了是配置错误，不能静默成功）`] };
  }
  const deployEnv = env.DEPLOY_ENV || 'production';
  if (!DEPLOY_ENVS.includes(deployEnv)) {
    return { ok: false, problems: [`DEPLOY_ENV 只能是 ${DEPLOY_ENVS.join(' | ')}，现在是 ${JSON.stringify(deployEnv)}`] };
  }

  if (target === 'workers' || target === 'esa') {
    const preview = deployEnv === 'preview';
    const name = target === 'workers'
      ? env[preview ? 'CLOUDFLARE_PREVIEW_WORKER_NAME' : 'CLOUDFLARE_WORKER_NAME']
      : env.ESA_PROJECT_NAME;
    if (!isDeploymentName(target, name)) {
      return { ok: false, problems: [`${target} 部署项目名缺失或格式无效`] };
    }
    if (target === 'workers' && preview && name.toLowerCase() === env.CLOUDFLARE_WORKER_NAME.toLowerCase()) {
      return { ok: false, problems: ['预览 Worker 必须使用不同于生产的独立名称'] };
    }
    const urlKey = target === 'workers' ? 'WORKERS_DEPLOY_URL' : 'ESA_DEPLOY_URL';
    let verifyUrl;
    try {
      const productionUrl = deploymentRoot(env[urlKey]);
      verifyUrl = target === 'workers' && preview ? deploymentRoot(env.WORKERS_PREVIEW_DEPLOY_URL) : productionUrl;
      if (target === 'workers' && preview && verifyUrl === productionUrl) throw new Error('预览验证地址必须与生产不同');
      if (target === 'esa' && preview && !isIP(env.ESA_PREVIEW_IP || '')) throw new Error('ESA_PREVIEW_IP 必须是控制台提供的测试环境 IP');
    } catch (e) { return { ok: false, problems: [e.message] }; }
    const configFile = target === 'workers' ? 'wrangler.jsonc' : 'esa.jsonc';
    const pnpmArgs = target === 'workers'
      ? [`--package=${WRANGLER_SPEC}`, 'dlx', 'wrangler', 'deploy', '--config', configFile]
      : [`--package=${ESA_CLI_SPEC}`, 'dlx', 'esa-cli', 'deploy', '--environment', preview ? 'staging' : 'production', '--no-preview'];
    return {
      ok: true, pnpmArgs, display: `pnpm ${pnpmArgs.join(' ')}`, env: { CI: 'true' },
      unsetEnv: target === 'esa' ? ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'] : [],
      configFile, configName: name, verifyUrl, ...(target === 'esa' && preview ? { verifyAddress: env.ESA_PREVIEW_IP } : {}),
    };
  }

  if (target === 'cloudflare') {
    // --commit-dirty=true 让 wrangler 别因工作区脏而问（CI 里 STATUS.md 会先写）
    const branch = deployEnv === 'production' ? CLOUDFLARE_PRODUCTION_BRANCH : CLOUDFLARE_PREVIEW_BRANCH;
    const pnpmArgs = [`--package=${WRANGLER_SPEC}`, 'dlx', 'wrangler', 'pages', 'deploy', distDir, '--project-name', config.deploy.cloudflare.project, '--branch', branch, '--commit-dirty=true'];
    return { ok: true, pnpmArgs, display: `pnpm ${pnpmArgs.join(' ')}`, env: {}, unsetEnv: [] };
  }

  // edgeone：CLI 的 -n 只认项目名（源码里按 Name 过滤取第一个，同名项目并存时会发错）。
  // 所以名字不是凭据、只是参数；项目 ID 由 deploy.mjs 在部署前用 Pages API 校验，
  // 校验不过就一个字节都不传。project ID 不能进 -n：CLI 会把它当名字，静默新建同名项目。
  const pnpmArgs = [`--package=${EDGEONE_CLI_SPEC}`, 'dlx', 'edgeone', 'makers', 'deploy', distDir, '-n', env.EDGEONE_PROJECT_NAME, '-e', deployEnv];
  const shown = pnpmArgs.map((a, i) => (pnpmArgs[i - 1] === '-n' ? '***' : a));
  return {
    ok: true,
    pnpmArgs,
    display: `pnpm ${shown.join(' ')}`,
    env: {
      // CLI 在 CI=true 时已是非交互；再显式声明一次，避免任何提示把流水线挂住（CLI 包里查到的开关）
      EDGEONE_NON_INTERACTIVE: '1',
      EDGEONE_PAGES_API_TOKEN: env.EDGEONE_API_TOKEN,
    },
    // CLI 包里有按 EDGEONE_PROJECT_ID 取 ProjectId 的路径：部署命令只用 -n（名字），
    // ID 与区域不能让 CLI 顺手读到；原始 token 变量也不透传，只经上面那一个通道给
    unsetEnv: ['EDGEONE_API_TOKEN', 'EDGEONE_PROJECT_ID', 'EDGEONE_PROJECT_NAME', 'EDGEONE_API_REGION', 'EDGEONE_API_BASE_URL'],
  };
}

/**
 * GitHub Pages 基线：dist 里必须有 .nojekyll / 404.html / index.html；deploy.github.cname 为真时
 * CNAME 内容必须等于 site.domain（CNAME 写错，Pages 会把站点绑到别的域名或直接拒绝）；为假时
 * 不该有 CNAME（残留的 CNAME 会让 Pages 认一个不归我们管的域名）。
 * @param {{ config: import('@gallery/platform').SiteConfig, files: Record<string, string|null> }} input
 *   files：文件名 → 内容；不存在给 null
 * @returns {string[]} 问题列表，空数组即通过
 */
export function checkGithubBaseline({ config, files }) {
  const problems = [];
  for (const name of GITHUB_BASELINE_FILES) {
    const content = files[name];
    if (content == null) problems.push(`dist/${name} 不存在（GitHub Pages 基线文件，build:site 应生成）`);
    else if (name !== '.nojekyll' && content.trim() === '') problems.push(`dist/${name} 是空文件`);
  }
  const cname = files.CNAME;
  if (config.deploy.github.cname) {
    if (cname == null) problems.push('dist/CNAME 不存在，但 deploy.github.cname 为 true');
    else if (cname.trim() !== config.site.domain) {
      problems.push(`dist/CNAME 内容是 ${JSON.stringify(cname.trim())}，应等于 site.domain（${config.site.domain}）`);
    }
  } else if (cname != null) {
    problems.push('deploy.github.cname 为 false 但 dist/CNAME 存在（残留的 CNAME 会让 Pages 绑到别的域名）');
  }
  return problems;
}
