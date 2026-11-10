// 部署命令拼装与基线校验的单测 + deploy 脚本 cloudflare / edgeone 两条路的端到端（不真部署）。
//
// 纯函数部分逐个参数比对：命令行是文档约定（ARCHITECTURE §3），改一个参数都该有测试红。
// 脚本部分验「凭据缺失退 1、DEPLOY_DRY_RUN 只打印、日志里不出现 token」，再用一个假的 npm_execpath
// 启动本地 pnpm 替身：看交给 CLI 的参数与环境（token 只经 EDGEONE_PAGES_API_TOKEN 给、原始 secrets 不透传）
// 与退出码的透传——真跑 CLI 要连外部服务，那是首次真实部署时人做的事。github 那条路在 deploy-github.test.mjs。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadSiteConfig } from '../lib/config.mjs';
import { deploymentReceipt, releaseFingerprint } from '../lib/release.mjs';
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
config.site.domain = 'gallery.unit-fixture.org';
config.images.hosts = ['images.unit-fixture.org'];
const configDir = await mkdtemp(join(tmpdir(), 'gallery-deploy-config-'));
const configFile = join(configDir, 'site.config.yaml');
await writeFile(configFile, yaml.dump(config));
after(() => rm(configDir, { recursive: true, force: true }));
const DIST = '/tmp/some dist';

test('requiredEnv：三个目标各自的凭据；返回副本', () => {
  assert.deepEqual(new Set(TARGETS), new Set(['cloudflare', 'edgeone', 'github', 'workers', 'esa']));
  assert.deepEqual(requiredEnv('cloudflare'), ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  assert.deepEqual(requiredEnv('edgeone'), ['EDGEONE_API_TOKEN', 'EDGEONE_PROJECT_ID', 'EDGEONE_PROJECT_NAME']);
  assert.deepEqual(requiredEnv('github'), []);
  assert.deepEqual(requiredEnv('nope'), []);
  requiredEnv('cloudflare').push('x');
  assert.equal(requiredEnv('cloudflare').length, 2);
});

test('planDeployCommand cloudflare：wrangler@4 pages deploy，项目名取配置，生产分支 main，凭据由 CLI 从环境读', () => {
  const env = { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' };
  const plan = planDeployCommand({ target: 'cloudflare', config, env, distDir: DIST });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.pnpmArgs, [`--package=${WRANGLER_SPEC}`, 'dlx', 'wrangler', 'pages', 'deploy', DIST, '--project-name', config.deploy.cloudflare.project, '--branch', 'main', '--commit-dirty=true']);
  assert.equal(WRANGLER_SPEC, 'wrangler@4');
  assert.equal(plan.display, `pnpm --package=wrangler@4 dlx wrangler pages deploy ${DIST} --project-name ${config.deploy.cloudflare.project} --branch main --commit-dirty=true`);
  assert.deepEqual(plan.env, {});
  assert.deepEqual(plan.unsetEnv, [], 'wrangler 要从环境读 CLOUDFLARE_*，什么都不删');
  assert.ok(!plan.pnpmArgs.includes('tok') && !plan.pnpmArgs.includes('acc'), 'token 与账号不进命令行');
  assert.equal(CLOUDFLARE_PRODUCTION_BRANCH, 'main');
});

test('planDeployCommand edgeone：-n 只取项目名（不是项目 ID）；token 走环境变量不进命令行；ID 与区域不透传', () => {
  const env = {
    EDGEONE_API_TOKEN: 'secret-token-xyz',
    EDGEONE_PROJECT_ID: 'makers-abc123',
    EDGEONE_PROJECT_NAME: 'proj-name',
  };
  const plan = planDeployCommand({ target: 'edgeone', config, env, distDir: DIST });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.pnpmArgs, [`--package=${EDGEONE_CLI_SPEC}`, 'dlx', 'edgeone', 'makers', 'deploy', DIST, '-n', 'proj-name', '-e', 'production']);
  assert.ok(!plan.pnpmArgs.includes('makers-abc123'), '项目 ID 不能进 -n：CLI 会把它当名字，静默新建同名项目');
  assert.equal(EDGEONE_CLI_SPEC, 'edgeone@1');
  assert.equal(plan.display, `pnpm --package=edgeone@1 dlx edgeone makers deploy ${DIST} -n *** -e production`);
  assert.ok(!plan.pnpmArgs.includes('-t') && !plan.pnpmArgs.includes('secret-token-xyz'), 'token 不进命令行');
  assert.deepEqual(plan.env, { EDGEONE_NON_INTERACTIVE: '1', EDGEONE_PAGES_API_TOKEN: 'secret-token-xyz' });
  assert.deepEqual(plan.unsetEnv, ['EDGEONE_API_TOKEN', 'EDGEONE_PROJECT_ID', 'EDGEONE_PROJECT_NAME', 'EDGEONE_API_REGION', 'EDGEONE_API_BASE_URL']);
});

test('planDeployCommand：DEPLOY_ENV=preview → cloudflare --branch preview、edgeone -e preview；非法值是问题；空串当没设', () => {
  assert.deepEqual(DEPLOY_ENVS, ['production', 'preview']);
  const cf = planDeployCommand({ target: 'cloudflare', config, env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', DEPLOY_ENV: 'preview' }, distDir: DIST });
  assert.equal(cf.ok, true);
  assert.deepEqual(cf.pnpmArgs.slice(-3), ['--branch', 'preview', '--commit-dirty=true']);
  const eo = planDeployCommand({ target: 'edgeone', config, env: { EDGEONE_API_TOKEN: 't', EDGEONE_PROJECT_ID: 'makers-p', EDGEONE_PROJECT_NAME: 'p', DEPLOY_ENV: 'preview' }, distDir: DIST });
  assert.equal(eo.ok, true);
  assert.deepEqual(eo.pnpmArgs.slice(-2), ['-e', 'preview']);
  const bad = planDeployCommand({ target: 'edgeone', config, env: { EDGEONE_API_TOKEN: 't', EDGEONE_PROJECT_ID: 'makers-p', EDGEONE_PROJECT_NAME: 'p', DEPLOY_ENV: 'staging' }, distDir: DIST });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /DEPLOY_ENV 只能是 production \| preview，现在是 "staging"/);
  const empty = planDeployCommand({ target: 'edgeone', config, env: { EDGEONE_API_TOKEN: 't', EDGEONE_PROJECT_ID: 'makers-p', EDGEONE_PROJECT_NAME: 'p', DEPLOY_ENV: '' }, distDir: DIST });
  assert.deepEqual(empty.pnpmArgs.slice(-2), ['-e', 'production']);
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

  const empty = planDeployCommand({ target: 'edgeone', config, env: { EDGEONE_API_TOKEN: '', EDGEONE_PROJECT_ID: 'makers-p', EDGEONE_PROJECT_NAME: 'p' }, distDir: DIST });
  assert.equal(empty.ok, false);
  assert.match(empty.problems[0], /缺少 EDGEONE_API_TOKEN（/, '空串也算缺');

  const gh = planDeployCommand({ target: 'github', config, env: {}, distDir: DIST });
  assert.equal(gh.ok, false);
  assert.match(gh.problems[0], /推 gh-pages/);

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
  assert.ok(wrong[0].includes(`"wrong.example.org"，应等于 site.domain（${config.site.domain}）`));

  // cname 关：不该有 CNAME
  const noCname = { ...config, deploy: { ...config.deploy, github: { cname: false } } };
  assert.deepEqual(checkGithubBaseline({ config: noCname, files: { ...good, CNAME: null } }), []);
  const stale = checkGithubBaseline({ config: noCname, files: good });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /cname 为 false 但 dist\/CNAME 存在/);
});

test('Workers 生产与预览都在计划阶段拒绝末尾连字符，ESA 名称继续兼容', () => {
  const workers = {
    CLOUDFLARE_API_TOKEN: 'fixture-token', CLOUDFLARE_ACCOUNT_ID: 'fixture-account',
    CLOUDFLARE_WORKER_NAME: 'fixture-production', CLOUDFLARE_PREVIEW_WORKER_NAME: 'fixture-preview',
    WORKERS_DEPLOY_URL: 'https://worker.unit-fixture.org', WORKERS_PREVIEW_DEPLOY_URL: 'https://preview-worker.unit-fixture.org',
  };
  for (const environment of ['production', 'preview']) {
    const nameKey = environment === 'preview' ? 'CLOUDFLARE_PREVIEW_WORKER_NAME' : 'CLOUDFLARE_WORKER_NAME';
    for (const name of ['fixture-', '-fixture', 'x'.repeat(64)]) {
      const plan = planDeployCommand({ target: 'workers', config, distDir: DIST,
        env: { ...workers, DEPLOY_ENV: environment, [nameKey]: name } });
      assert.equal(plan.ok, false);
      assert.match(plan.problems.join(), /项目名.*格式无效/);
    }
    for (const name of ['a', 'fixture-valid', 'x'.repeat(63)]) {
      assert.equal(planDeployCommand({ target: 'workers', config, distDir: DIST,
        env: { ...workers, DEPLOY_ENV: environment, [nameKey]: name } }).ok, true);
    }
  }
  assert.equal(planDeployCommand({ target: 'esa', config, distDir: DIST, env: {
    ESA_ACCESS_KEY_ID: 'fixture-id', ESA_ACCESS_KEY_SECRET: 'fixture-secret',
    ESA_PROJECT_NAME: 'Fixture_Production-', ESA_DEPLOY_URL: 'https://esa.unit-fixture.org',
  } }).ok, true);
});

// ── deploy 脚本（cloudflare / edgeone）────────────────────────────────

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLOUDFLARE_|EDGEONE_|DEPLOY_|DIST_DIR$|OUT_DIR$|RELEASE_VERSION$|CONFIG_FILE$)/.test(k)) delete env[k];
  env.CONFIG_FILE = configFile;
  return env;
}

/** 假 Pages API：deploy 脚本部署前会按 ID / 名字各查一次，这里固定返回同一个直传项目。 */
async function edgeoneApiServer(t) {
  const project = { ProjectId: 'makers-abc123', Name: 'proj-name', Provider: 'Upload', Area: 'global' };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      const projects = json.ProjectIds ? [project] : [project];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Code: 0, Data: { Response: { Projects: projects } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // fetch 默认 keep-alive：不主动断掉空闲连接，server.close() 会一直等
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...cleanEnv(), ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * 异步 spawn：假 Pages API 就住在测试进程里，spawnSync 会把事件循环卡住，
 * 服务器答不了话、子进程等回应——死锁。
 */
function runAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...cleanEnv(), ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** 假 CLI 只验证部署边界：提供相互匹配的构建清单与 dist 标记，不连接对象存储。 */
async function releaseInput(distDir, outDir, environment = 'production') {
  const manifest = {
    version: 'deploy-test', site: { domain: config.site.domain },
    db: { version: 'deploy-test', key: 'db/gallery-deploy-test.sqlite', size: 4096, sha256: 'a'.repeat(64) },
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(distDir, 'release.json'), JSON.stringify({ version: manifest.version, fingerprint: releaseFingerprint(manifest), environment }));
  return manifest;
}

test('deploy 脚本：未知目标退 2；dist 不存在退 1；缺凭据退 1；DEPLOY_DRY_RUN 只打印且不泄露 token', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dist = join(tmp, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html>');

  const usage = run(['vercel'], {});
  assert.equal(usage.status, 2);
  assert.match(usage.out, /用法：node scripts\/deploy\.mjs <cloudflare\|edgeone\|github\|workers\|esa>/);
  assert.equal(run([], {}).status, 2);

  const noDist = run(['cloudflare'], { DIST_DIR: join(tmp, 'nope'), CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' });
  assert.equal(noDist.status, 1, noDist.out);
  assert.match(noDist.out, /不存在：先 pnpm run build/);
  assert.doesNotMatch(noDist.out, /\n\s+at /, '预期中的错误不打栈');

  const noCreds = run(['cloudflare'], { DIST_DIR: dist });
  assert.equal(noCreds.status, 1, noCreds.out);
  assert.match(noCreds.out, /缺少 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID/);

  const cf = run(['cloudflare'], { DIST_DIR: dist, CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', DEPLOY_DRY_RUN: '1' });
  assert.equal(cf.status, 0, cf.out);
  assert.ok(
    cf.out.includes(`pnpm --package=wrangler@4 dlx wrangler pages deploy ${dist} --project-name ${config.deploy.cloudflare.project} --branch main --commit-dirty=true`),
    cf.out,
  );
  assert.match(cf.out, /DEPLOY_DRY_RUN=1：只打印命令，不执行/);

  const eo = run(['edgeone'], { DIST_DIR: dist, EDGEONE_API_TOKEN: 'secret-token-xyz', EDGEONE_PROJECT_ID: 'makers-abc123', EDGEONE_PROJECT_NAME: 'proj-name', DEPLOY_DRY_RUN: '1' });
  assert.equal(eo.status, 0, eo.out);
  assert.match(eo.out, /edgeone@1 dlx edgeone makers deploy .+ -n \*\*\* -e production/);
  assert.doesNotMatch(eo.out, /secret-token-xyz|makers-abc123|proj-name| -t /, '日志里不出现凭据，命令行没有 -t');

  const preview = run(['edgeone'], { DIST_DIR: dist, EDGEONE_API_TOKEN: 'x', EDGEONE_PROJECT_ID: 'makers-p', EDGEONE_PROJECT_NAME: 'p', DEPLOY_DRY_RUN: '1', DEPLOY_ENV: 'preview' });
  assert.equal(preview.status, 0, preview.out);
  assert.match(preview.out, / -e preview\n/);
  assert.match(preview.out, /DEPLOY_ENV=preview：发到预览环境/);

  const eoMissing = run(['edgeone'], { DIST_DIR: dist, EDGEONE_API_TOKEN: 'x' });
  assert.equal(eoMissing.status, 1, eoMissing.out);
  assert.match(eoMissing.out, /缺少 EDGEONE_PROJECT_ID、EDGEONE_PROJECT_NAME/);
});

test('deploy 脚本：通过 pnpm JavaScript 入口启动本地替身——交给 CLI 的参数与环境；token 只经环境变量给；退出码原样透传', { timeout: 30_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const apiBase = await edgeoneApiServer(t);
  const dist = join(tmp, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html>');
  const outDir = join(tmp, 'out');
  const manifest = await releaseInput(dist, outDir);
  // 本地 pnpm 替身：把收到的参数与我们关心的环境变量打成一行 JSON；退出码由 FAKE_NPM_EXIT 决定。
  // 这里采用 JavaScript 入口覆盖 Node 启动路径；原生程序另由运行器回归验证。
  const fakeNpm = join(tmp, 'pnpm.mjs');
  await writeFile(
    fakeNpm,
    [
      "const keys = ['EDGEONE_API_TOKEN', 'EDGEONE_PROJECT_ID', 'EDGEONE_PROJECT_NAME', 'EDGEONE_API_REGION', 'EDGEONE_API_BASE_URL', 'EDGEONE_PAGES_API_TOKEN', 'EDGEONE_NON_INTERACTIVE', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];",
      "console.log('FAKE_NPM ' + JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(keys.map((k) => [k, process.env[k]])) }));",
      'process.exit(Number(process.env.FAKE_NPM_EXIT || 0));',
      '',
    ].join('\n'),
  );
  // JSON.stringify 会丢掉值为 undefined 的键：seen().env 里只剩真的交给了 CLI 的那些
  const seen = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('FAKE_NPM ')).slice('FAKE_NPM '.length));

  const eo = await runAsync(['edgeone'], {
    DIST_DIR: dist,
    OUT_DIR: outDir,
    npm_execpath: fakeNpm,
    EDGEONE_API_TOKEN: 'secret-token-xyz',
    EDGEONE_PROJECT_ID: 'makers-abc123',
    EDGEONE_PROJECT_NAME: 'proj-name',
    EDGEONE_API_BASE_URL: apiBase,
  });
  assert.equal(eo.status, 0, eo.out);
  assert.match(eo.out, /deploy:edgeone 完成/);
  const e = seen(eo.out);
  assert.deepEqual(e.argv, ['--package=edgeone@1', 'dlx', 'edgeone', 'makers', 'deploy', dist, '-n', 'proj-name', '-e', 'production']);
  assert.deepEqual(e.env, { EDGEONE_PAGES_API_TOKEN: 'secret-token-xyz', EDGEONE_NON_INTERACTIVE: '1' }, 'ID / 名字 / 区域 / 原始 token 都不透传给 CLI');
  assert.deepEqual(JSON.parse(await readFile(join(outDir, 'deployed-edgeone.json'), 'utf8')), deploymentReceipt(manifest, 'edgeone', 'production'));

  const cf = await runAsync(['cloudflare'], { DIST_DIR: dist, OUT_DIR: outDir, npm_execpath: fakeNpm, CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' });
  assert.equal(cf.status, 0, cf.out);
  const c = seen(cf.out);
  assert.deepEqual(c.argv, ['--package=wrangler@4', 'dlx', 'wrangler', 'pages', 'deploy', dist, '--project-name', config.deploy.cloudflare.project, '--branch', 'main', '--commit-dirty=true']);
  assert.deepEqual(c.env, { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' }, 'wrangler 从环境读凭据，必须原样在');
  assert.deepEqual(JSON.parse(await readFile(join(outDir, 'deployed-cloudflare.json'), 'utf8')), deploymentReceipt(manifest, 'cloudflare', 'production'));

  await releaseInput(dist, outDir, 'preview');
  const preview = await runAsync(['cloudflare'], { DIST_DIR: dist, OUT_DIR: outDir, DEPLOY_ENV: 'preview', npm_execpath: fakeNpm, CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' });
  assert.equal(preview.status, 0, preview.out);
  assert.deepEqual(JSON.parse(await readFile(join(outDir, 'deployed-cloudflare.json'), 'utf8')), deploymentReceipt(manifest, 'cloudflare', 'preview'));
  await releaseInput(dist, outDir);

  const failed = await runAsync(['edgeone'], {
    DIST_DIR: dist,
    OUT_DIR: outDir,
    npm_execpath: fakeNpm,
    EDGEONE_API_TOKEN: 'x',
    EDGEONE_PROJECT_ID: 'makers-abc123',
    EDGEONE_PROJECT_NAME: 'proj-name',
    EDGEONE_API_BASE_URL: apiBase,
    FAKE_NPM_EXIT: '3',
  });
  assert.equal(failed.status, 3, failed.out);
  assert.match(failed.out, /deploy:edgeone 失败，CLI 退出码 3/);
  await assert.rejects(readFile(join(outDir, 'deployed-edgeone.json')), { code: 'ENOENT' }, '失败不能留下上次成功的部署凭据');
});

test('deploy 脚本：缺少完整清单或 dist 标记不匹配时，在启动 CLI 前拒绝', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-input-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dist = join(tmp, 'dist');
  const outDir = join(tmp, 'out');
  await mkdir(dist);
  const env = { DIST_DIR: dist, OUT_DIR: outDir, CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', npm_execpath: join(tmp, 'must-not-run.mjs') };
  const missing = run(['cloudflare'], env);
  assert.equal(missing.status, 1, missing.out);
  assert.match(missing.out, /缺少本次完整构建的发布清单/);
  const manifest = await releaseInput(dist, outDir);
  await writeFile(join(dist, 'release.json'), JSON.stringify({ version: manifest.version, fingerprint: '0'.repeat(64), environment: 'production' }));
  await writeFile(join(outDir, 'deployed-cloudflare.json'), JSON.stringify(deploymentReceipt(manifest, 'cloudflare', 'production')));
  const stale = run(['cloudflare'], env);
  assert.equal(stale.status, 1, stale.out);
  assert.match(stale.out, /dist 与发布清单不属于同一次构建/);
  assert.doesNotMatch(stale.out, /MODULE_NOT_FOUND/);
  await assert.rejects(readFile(join(outDir, 'deployed-cloudflare.json')), { code: 'ENOENT' });
});

test('deploy 脚本：preview 产物不能用于 production，旧标记缺少环境也拒绝', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-environment-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dist = join(tmp, 'dist');
  const outDir = join(tmp, 'out');
  await mkdir(dist);
  const manifest = await releaseInput(dist, outDir, 'preview');
  const env = { DIST_DIR: dist, OUT_DIR: outDir, DEPLOY_ENV: 'production', CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', npm_execpath: join(tmp, 'must-not-run.mjs') };
  for (const environment of ['preview', undefined]) {
    await writeFile(join(dist, 'release.json'), JSON.stringify({ version: manifest.version, fingerprint: releaseFingerprint(manifest), environment }));
    const rejected = run(['cloudflare'], env);
    assert.equal(rejected.status, 1, rejected.out);
    assert.match(rejected.out, /dist 与发布清单|环境/);
    assert.doesNotMatch(rejected.out, /MODULE_NOT_FOUND/);
    await assert.rejects(readFile(join(outDir, 'deployed-cloudflare.json')), { code: 'ENOENT' });
  }
});
