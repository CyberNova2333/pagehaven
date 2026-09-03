// 部署命令拼装与基线校验的单测 + deploy 脚本 cloudflare / edgeone 两条路的端到端（不真部署）。
//
// 纯函数部分逐个参数比对：命令行是文档约定（ARCHITECTURE §3），改一个参数都该有测试红。
// 脚本部分验「凭据缺失退 1、DEPLOY_DRY_RUN 只打印、日志里不出现 token」，再用一个假的 npm_execpath
// 真起一次 npm：看交给 CLI 的参数与环境（token 只经 EDGEONE_PAGES_API_TOKEN 给、原始 secrets 不透传）
// 与退出码的透传——真跑 CLI 要连外部服务，那是首次真实部署时人做的事。github 那条路在 deploy-github.test.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../lib/config.mjs';
import {
  TARGETS,
  DEPLOY_ENVS,
  WRANGLER_SPEC,
  EDGEONE_CLI_SPEC,
  GITHUB_BASELINE_FILES,
  CLOUDFLARE_PRODUCTION_BRANCH,
  requiredEnv,
  planDeployCommand,
  checkGithubBaseline,
} from '../lib/deploy-plan.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'deploy.mjs');
const config = await loadSiteConfig();
const DIST = '/tmp/some dist';

test('requiredEnv：三个目标各自的凭据；返回副本', () => {
  assert.deepEqual(TARGETS, ['cloudflare', 'edgeone', 'github']);
  assert.deepEqual(requiredEnv('cloudflare'), ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  assert.deepEqual(requiredEnv('edgeone'), ['EDGEONE_API_TOKEN', 'EDGEONE_PROJECT_ID']);
  assert.deepEqual(requiredEnv('github'), []);
  assert.deepEqual(requiredEnv('nope'), []);
  requiredEnv('cloudflare').push('x');
  assert.equal(requiredEnv('cloudflare').length, 2);
});

test('planDeployCommand cloudflare：wrangler@4 pages deploy，项目名取配置，生产分支 main，凭据由 CLI 从环境读', () => {
  const env = { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' };
  const plan = planDeployCommand({ target: 'cloudflare', config, env, distDir: DIST });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.npmArgs, ['exec', '--yes', '--', WRANGLER_SPEC, 'pages', 'deploy', DIST, '--project-name', config.deploy.cloudflare.project, '--branch', 'main', '--commit-dirty=true']);
  assert.equal(WRANGLER_SPEC, 'wrangler@4');
  assert.equal(plan.display, `npm exec --yes -- wrangler@4 pages deploy ${DIST} --project-name ${config.deploy.cloudflare.project} --branch main --commit-dirty=true`);
  assert.deepEqual(plan.env, {});
  assert.deepEqual(plan.unsetEnv, [], 'wrangler 要从环境读 CLOUDFLARE_*，什么都不删');
  assert.ok(!plan.npmArgs.includes('tok') && !plan.npmArgs.includes('acc'), 'token 与账号不进命令行');
  assert.equal(CLOUDFLARE_PRODUCTION_BRANCH, 'main');
});

test('planDeployCommand edgeone：edgeone@1 makers deploy <dist> -n <项目名> -e production；token 走环境变量不进命令行；原始 secrets 不透传', () => {
  const env = { EDGEONE_API_TOKEN: 'secret-token-xyz', EDGEONE_PROJECT_ID: 'proj-name' };
  const plan = planDeployCommand({ target: 'edgeone', config, env, distDir: DIST });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.npmArgs, ['exec', '--yes', '--', EDGEONE_CLI_SPEC, 'makers', 'deploy', DIST, '-n', 'proj-name', '-e', 'production']);
  assert.equal(EDGEONE_CLI_SPEC, 'edgeone@1');
  assert.equal(plan.display, `npm exec --yes -- edgeone@1 makers deploy ${DIST} -n *** -e production`);
  assert.ok(!plan.npmArgs.includes('-t') && !plan.npmArgs.includes('secret-token-xyz'), 'token 不进命令行');
  assert.deepEqual(plan.env, { EDGEONE_NON_INTERACTIVE: '1', EDGEONE_PAGES_API_TOKEN: 'secret-token-xyz' });
  assert.deepEqual(plan.unsetEnv, ['EDGEONE_API_TOKEN', 'EDGEONE_PROJECT_ID']);
});

test('planDeployCommand：DEPLOY_ENV=preview → cloudflare --branch preview、edgeone -e preview；非法值是问题；空串当没设', () => {
  assert.deepEqual(DEPLOY_ENVS, ['production', 'preview']);
  const cf = planDeployCommand({ target: 'cloudflare', config, env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', DEPLOY_ENV: 'preview' }, distDir: DIST });
  assert.equal(cf.ok, true);
  assert.deepEqual(cf.npmArgs.slice(-3), ['--branch', 'preview', '--commit-dirty=true']);
  const eo = planDeployCommand({ target: 'edgeone', config, env: { EDGEONE_API_TOKEN: 't', EDGEONE_PROJECT_ID: 'p', DEPLOY_ENV: 'preview' }, distDir: DIST });
  assert.equal(eo.ok, true);
  assert.deepEqual(eo.npmArgs.slice(-2), ['-e', 'preview']);
  const bad = planDeployCommand({ target: 'edgeone', config, env: { EDGEONE_API_TOKEN: 't', EDGEONE_PROJECT_ID: 'p', DEPLOY_ENV: 'staging' }, distDir: DIST });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /DEPLOY_ENV 只能是 production \| preview，现在是 "staging"/);
  const empty = planDeployCommand({ target: 'edgeone', config, env: { EDGEONE_API_TOKEN: 't', EDGEONE_PROJECT_ID: 'p', DEPLOY_ENV: '' }, distDir: DIST });
  assert.deepEqual(empty.npmArgs.slice(-2), ['-e', 'production']);
});

test('planDeployCommand：缺凭据逐个点名；github 不由命令部署；未知目标', () => {
  const cf = planDeployCommand({ target: 'cloudflare', config, env: { CLOUDFLARE_API_TOKEN: 'tok' }, distDir: DIST });
  assert.equal(cf.ok, false);
  assert.equal(cf.problems.length, 1);
  assert.match(cf.problems[0], /缺少 CLOUDFLARE_ACCOUNT_ID（/);
  assert.doesNotMatch(cf.problems[0], /CLOUDFLARE_API_TOKEN/);

  const both = planDeployCommand({ target: 'cloudflare', config, env: {}, distDir: DIST });
  assert.match(both.problems[0], /缺少 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID/);
  assert.match(both.problems[0], /不能静默成功/);

  const empty = planDeployCommand({ target: 'edgeone', config, env: { EDGEONE_API_TOKEN: '', EDGEONE_PROJECT_ID: 'p' }, distDir: DIST });
  assert.equal(empty.ok, false);
  assert.match(empty.problems[0], /缺少 EDGEONE_API_TOKEN（/, '空串也算缺');

  const gh = planDeployCommand({ target: 'github', config, env: {}, distDir: DIST });
  assert.equal(gh.ok, false);
  assert.match(gh.problems[0], /upload-pages-artifact/);

  const nope = planDeployCommand({ target: 'vercel', config, env: {}, distDir: DIST });
  assert.equal(nope.ok, false);
  assert.match(nope.problems[0], /未知的部署目标 "vercel"/);
});

test('checkGithubBaseline：三个基线文件 + CNAME 与 site.domain 一致', () => {
  assert.deepEqual(GITHUB_BASELINE_FILES, ['.nojekyll', '404.html', 'index.html']);
  const good = { '.nojekyll': '', '404.html': '<h1>404</h1>', 'index.html': '<!doctype html>', CNAME: `${config.site.domain}\n` };
  assert.deepEqual(checkGithubBaseline({ config, files: good }), []);

  const missing = checkGithubBaseline({ config, files: { '.nojekyll': null, '404.html': null, 'index.html': null, CNAME: null } });
  assert.equal(missing.length, 4);
  assert.match(missing[0], /dist\/\.nojekyll 不存在/);
  assert.match(missing[1], /dist\/404\.html 不存在/);
  assert.match(missing[2], /dist\/index\.html 不存在/);
  assert.match(missing[3], /dist\/CNAME 不存在，但 deploy\.github\.cname 为 true/);

  const empties = checkGithubBaseline({ config, files: { ...good, '404.html': '  \n', 'index.html': '' } });
  assert.deepEqual(empties.map((p) => p.split(' ')[0]), ['dist/404.html', 'dist/index.html']);
  assert.match(empties[0], /空文件/);

  const wrong = checkGithubBaseline({ config, files: { ...good, CNAME: 'wrong.example.org\n' } });
  assert.equal(wrong.length, 1);
  assert.match(wrong[0], /"wrong\.example\.org"，应等于 site\.domain（gallery\.example\.org）/);

  // cname 关：不该有 CNAME
  const noCname = { ...config, deploy: { ...config.deploy, github: { cname: false } } };
  assert.deepEqual(checkGithubBaseline({ config: noCname, files: { ...good, CNAME: null } }), []);
  const stale = checkGithubBaseline({ config: noCname, files: good });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /cname 为 false 但 dist\/CNAME 存在/);
});

// ── deploy 脚本（cloudflare / edgeone）────────────────────────────────

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLOUDFLARE_|EDGEONE_|DEPLOY_|DIST_DIR$)/.test(k)) delete env[k];
  return env;
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...cleanEnv(), ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('deploy 脚本：未知目标退 2；dist 不存在退 1；缺凭据退 1；DEPLOY_DRY_RUN 只打印且不泄露 token', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dist = join(tmp, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html>');

  const usage = run(['vercel'], {});
  assert.equal(usage.status, 2);
  assert.match(usage.out, /用法：node scripts\/deploy\.mjs <cloudflare\|edgeone\|github>/);
  assert.equal(run([], {}).status, 2);

  const noDist = run(['cloudflare'], { DIST_DIR: join(tmp, 'nope'), CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' });
  assert.equal(noDist.status, 1, noDist.out);
  assert.match(noDist.out, /不存在：先 npm run build/);
  assert.doesNotMatch(noDist.out, /\n\s+at /, '预期中的错误不打栈');

  const noCreds = run(['cloudflare'], { DIST_DIR: dist });
  assert.equal(noCreds.status, 1, noCreds.out);
  assert.match(noCreds.out, /缺少 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID/);

  const cf = run(['cloudflare'], { DIST_DIR: dist, CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', DEPLOY_DRY_RUN: '1' });
  assert.equal(cf.status, 0, cf.out);
  assert.match(cf.out, new RegExp(`npm exec --yes -- wrangler@4 pages deploy ${dist} --project-name ${config.deploy.cloudflare.project} --branch main --commit-dirty=true`));
  assert.match(cf.out, /DEPLOY_DRY_RUN=1：只打印命令，不执行/);

  const eo = run(['edgeone'], { DIST_DIR: dist, EDGEONE_API_TOKEN: 'secret-token-xyz', EDGEONE_PROJECT_ID: 'proj-123', DEPLOY_DRY_RUN: '1' });
  assert.equal(eo.status, 0, eo.out);
  assert.match(eo.out, new RegExp(`npm exec --yes -- edgeone@1 makers deploy ${dist} -n \\*\\*\\* -e production\\n`));
  assert.doesNotMatch(eo.out, /secret-token-xyz|proj-123| -t /, '日志里不出现凭据，命令行没有 -t');

  const preview = run(['edgeone'], { DIST_DIR: dist, EDGEONE_API_TOKEN: 'x', EDGEONE_PROJECT_ID: 'p', DEPLOY_DRY_RUN: '1', DEPLOY_ENV: 'preview' });
  assert.equal(preview.status, 0, preview.out);
  assert.match(preview.out, / -e preview\n/);
  assert.match(preview.out, /DEPLOY_ENV=preview：发到预览环境/);

  const eoMissing = run(['edgeone'], { DIST_DIR: dist, EDGEONE_API_TOKEN: 'x' });
  assert.equal(eoMissing.status, 1, eoMissing.out);
  assert.match(eoMissing.out, /缺少 EDGEONE_PROJECT_ID/);
});

test('deploy 脚本：真起 npm（假的 npm_execpath）——交给 CLI 的参数与环境；token 只经环境变量给；退出码原样透传', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dist = join(tmp, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html>');
  // 假 npm：把收到的参数与我们关心的环境变量打成一行 JSON；退出码由 FAKE_NPM_EXIT 决定。
  // deploy.mjs 在 npm_execpath 存在时用 node 起它，所以这里能拦住整条真实的 spawn 路径
  const fakeNpm = join(tmp, 'fake-npm.mjs');
  await writeFile(
    fakeNpm,
    [
      "const keys = ['EDGEONE_API_TOKEN', 'EDGEONE_PROJECT_ID', 'EDGEONE_PAGES_API_TOKEN', 'EDGEONE_NON_INTERACTIVE', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];",
      "console.log('FAKE_NPM ' + JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(keys.map((k) => [k, process.env[k]])) }));",
      'process.exit(Number(process.env.FAKE_NPM_EXIT || 0));',
      '',
    ].join('\n'),
  );
  // JSON.stringify 会丢掉值为 undefined 的键：seen().env 里只剩真的交给了 CLI 的那些
  const seen = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('FAKE_NPM ')).slice('FAKE_NPM '.length));

  const eo = run(['edgeone'], { DIST_DIR: dist, npm_execpath: fakeNpm, EDGEONE_API_TOKEN: 'secret-token-xyz', EDGEONE_PROJECT_ID: 'proj-name' });
  assert.equal(eo.status, 0, eo.out);
  assert.match(eo.out, /deploy:edgeone 完成/);
  const e = seen(eo.out);
  assert.deepEqual(e.argv, ['exec', '--yes', '--', 'edgeone@1', 'makers', 'deploy', dist, '-n', 'proj-name', '-e', 'production']);
  assert.deepEqual(e.env, { EDGEONE_PAGES_API_TOKEN: 'secret-token-xyz', EDGEONE_NON_INTERACTIVE: '1' }, 'EDGEONE_API_TOKEN / EDGEONE_PROJECT_ID 不透传给 CLI');

  const cf = run(['cloudflare'], { DIST_DIR: dist, npm_execpath: fakeNpm, CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' });
  assert.equal(cf.status, 0, cf.out);
  const c = seen(cf.out);
  assert.deepEqual(c.argv, ['exec', '--yes', '--', 'wrangler@4', 'pages', 'deploy', dist, '--project-name', config.deploy.cloudflare.project, '--branch', 'main', '--commit-dirty=true']);
  assert.deepEqual(c.env, { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' }, 'wrangler 从环境读凭据，必须原样在');

  const failed = run(['edgeone'], { DIST_DIR: dist, npm_execpath: fakeNpm, EDGEONE_API_TOKEN: 'x', EDGEONE_PROJECT_ID: 'p', FAKE_NPM_EXIT: '3' });
  assert.equal(failed.status, 3, failed.out);
  assert.match(failed.out, /deploy:edgeone 失败，CLI 退出码 3/);
});
