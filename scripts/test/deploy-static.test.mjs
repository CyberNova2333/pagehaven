import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { loadSiteConfig } from '../lib/config.mjs';
import { releaseFingerprint } from '../lib/release.mjs';
import { planDeployCommand } from '../lib/deploy-plan.mjs';
import { inspectDeploymentFiles, validateDeploymentBudget } from '../lib/deploy-budget.mjs';
import { deploymentRoot, waitForDeployment, createStagingVerifier } from '../lib/deploy-ready.mjs';
import { createDeploymentProof, deploymentProofFile, DEPLOY_PROOF_MAX_BYTES } from '../lib/deploy-proof.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const config = await loadSiteConfig();
config.site.domain = 'gallery.unit-fixture.org';
config.images.hosts = ['images.unit-fixture.org'];
const workers = {
  CLOUDFLARE_API_TOKEN: 'worker-secret-token', CLOUDFLARE_ACCOUNT_ID: 'account-secret',
  CLOUDFLARE_WORKER_NAME: 'fixture-production', CLOUDFLARE_PREVIEW_WORKER_NAME: 'fixture-preview',
  WORKERS_DEPLOY_URL: 'https://worker.unit-fixture.org', WORKERS_PREVIEW_DEPLOY_URL: 'https://preview-worker.unit-fixture.org',
};
const esa = {
  ESA_ACCESS_KEY_ID: 'esa-secret-id', ESA_ACCESS_KEY_SECRET: 'esa-secret-key', ESA_PROJECT_NAME: 'fixture-esa',
  ESA_DEPLOY_URL: 'https://esa.unit-fixture.org', ESA_PREVIEW_IP: '192.0.2.10',
};
const plan = (target, env) => planDeployCommand({ target, config, env, distDir: '/tmp/site' });

test('新增目标命令明确选择静态部署和环境，预览不得复用生产名称或地址', () => {
  assert.deepEqual(plan('workers', workers).pnpmArgs, ['--package=wrangler@4', 'dlx', 'wrangler', 'deploy', '--config', 'wrangler.jsonc']);
  const preview = plan('workers', { ...workers, DEPLOY_ENV: 'preview' });
  assert.equal(preview.configName, workers.CLOUDFLARE_PREVIEW_WORKER_NAME);
  assert.equal(preview.verifyUrl, workers.WORKERS_PREVIEW_DEPLOY_URL);
  assert.equal(plan('workers', { ...workers, DEPLOY_ENV: 'preview', CLOUDFLARE_PREVIEW_WORKER_NAME: workers.CLOUDFLARE_WORKER_NAME }).ok, false);
  assert.equal(plan('workers', { ...workers, DEPLOY_ENV: 'preview', WORKERS_PREVIEW_DEPLOY_URL: workers.WORKERS_DEPLOY_URL + '/' }).ok, false);
  assert.equal(plan('workers', { ...workers, CLOUDFLARE_WORKER_NAME: 'INVALID_NAME' }).ok, false);
  assert.equal(plan('workers', { ...workers, DEPLOY_ENV: 'preview', CLOUDFLARE_PREVIEW_WORKER_NAME: '' }).ok, false);
  assert.equal(plan('esa', { ...esa, DEPLOY_ENV: 'preview', ESA_PREVIEW_IP: '' }).ok, false);
  assert.equal(plan('esa', { ...esa, DEPLOY_ENV: 'preview' }).verifyAddress, esa.ESA_PREVIEW_IP);
  assert.equal(plan('esa', { ...esa, ESA_PREVIEW_IP: 'invalid-in-production' }).verifyAddress, undefined);
  assert.deepEqual(plan('esa', { ...esa, DEPLOY_ENV: 'preview' }).pnpmArgs,
    ['--package=esa-cli@1.0.13', 'dlx', 'esa-cli', 'deploy', '--environment', 'staging', '--no-preview']);
  for (const [target, env] of [['workers', workers], ['esa', esa]]) {
    assert.ok(!plan(target, env).display.includes('secret'));
    assert.equal(plan(target, {}).ok, false);
  }
});

test('部署总大小按官方十进制单位保守预检，刚好上限通过、多一字节拒绝', () => {
  for (const [target, limit] of [['github', 1_000_000_000], ['esa', 1_024_000_000]]) {
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `asset-${i}`, size: limit / 100 }));
    if (target === 'esa') files[0].size -= DEPLOY_PROOF_MAX_BYTES;
    assert.deepEqual(validateDeploymentBudget({ target, config, files }), []);
    files[0].size++;
    assert.match(validateDeploymentBudget({ target, config, files }).join(), /总大小/);
  }
});

test('部署预算保留18,000基线，ESA最多2,000文件，GitHub总大小与控制文件单独拒绝', () => {
  const files = Array.from({ length: 1999 }, (_, i) => ({ path: `${i}.html`, size: 100 }));
  assert.deepEqual(validateDeploymentBudget({ target: 'esa', config, files }), []);
  files.push({ path: 'extra.html', size: 1 });
  assert.match(validateDeploymentBudget({ target: 'esa', config, files }).join(), /2000/);
  assert.deepEqual(validateDeploymentBudget({ target: 'workers', config, files }), []);
  assert.match(validateDeploymentBudget({ target: 'workers', config, files: [{ path: 'large', size: 21 * 1024 * 1024 }] }).join(), /单文件/);
  assert.match(validateDeploymentBudget({ target: 'github', config, files: Array.from({ length: 100 }, () => ({ path: 'chunk', size: 20 * 1024 * 1024 })) }).join(), /总大小/);
  assert.match(validateDeploymentBudget({ target: 'workers', config, files: [{ path: 'wrangler.jsonc', size: 1 }] }).join(), /不能放入/);
  assert.match(validateDeploymentBudget({ target: 'esa', config, files: [{ path: 'backup/esa.jsonc', size: 1 }] }).join(), /不能放入/);
  assert.match(validateDeploymentBudget({ target: 'workers', config, files: [{ path: 'pagehaven-deploy-old.json', size: 1 }] }).join(), /保留路径/);
});

test('上线核对拒绝不安全URL、旧版本、错误环境和过大响应；重试成功才完成', async () => {
  for (const url of ['http://fixture.org', 'https://user:secret@fixture.org', 'https://fixture.org/?token=secret', 'https://fixture.org/#secret', 'https://fixture.org/path', 'https:\\fixture.org', 'https://fixture.org:444']) {
    assert.throws(() => deploymentRoot(url), /HTTPS/);
  }
  const receipt = { version: 'v1', fingerprint: 'a'.repeat(64), target: 'workers', environment: 'preview' };
  const proof = createDeploymentProof(receipt);
  let calls = 0;
  await waitForDeployment({ url: 'https://fixture.org/', receipt, proof, attempts: 2, intervalMs: 0,
    fetchImpl: async (url, options) => {
      assert.equal(url, `https://fixture.org/${deploymentProofFile(proof)}`);
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      calls++;
      return Response.json(calls === 1 ? { ...proof, version: 'old' } : proof);
    },
  });
  assert.equal(calls, 2);
  for (const response of [Response.json({ ...proof, environment: 'production' }), Response.json({ ...proof, fingerprint: 'b' }), new Response('x'.repeat(17000)), new Response('', { status: 302 }), new Response('not json')]) {
    await assert.rejects(waitForDeployment({ url: 'https://fixture.org', receipt, proof, attempts: 1, fetchImpl: async () => response }), /未记录部署成功/);
  }
  await assert.rejects(waitForDeployment({ url: 'https://fixture.org', receipt, proof, attempts: 1, fetchImpl: async () => { throw new Error('secret response'); } }), (error) => !error.message.includes('secret'));
});

test('共享域名返回同版本标记、另一平台或旧部署证明均不能确认当前部署', async () => {
  const receipt = { version: 'same-version', fingerprint: 'a'.repeat(64), target: 'workers', environment: 'production' };
  const proof = createDeploymentProof(receipt);
  const oldProof = createDeploymentProof(receipt);
  const otherPlatform = createDeploymentProof({ ...receipt, target: 'esa' });
  assert.notEqual(deploymentProofFile(proof), deploymentProofFile(oldProof), '同版本重试仍必须换验证路径');
  for (const marker of [receipt, oldProof, otherPlatform, { ...proof, target: 'esa' }]) {
    await assert.rejects(waitForDeployment({ url: 'https://shared.unit-fixture.org', receipt, proof, attempts: 1,
      fetchImpl: async () => Response.json(marker),
    }), /未记录部署成功/);
  }
  await assert.rejects(waitForDeployment({ url: 'https://shared.unit-fixture.org', receipt, proof: otherPlatform,
    fetchImpl: async () => { assert.fail('本地验证上下文错误时不能发请求'); },
  }), /不匹配/);
});

test('ESA预览在CI连接测试IP，保留正式Host和TLS域名，不依赖过期预览令牌', async () => {
  let connection;
  let closed = false;
  const dispatcher = { async close() { closed = true; } };
  const verifier = createStagingVerifier('192.0.2.10', {
    agentFactory(options) { connection = options.connect; return dispatcher; },
    async fetchImpl(url, options) {
      assert.equal(url, 'https://esa.unit-fixture.org/release.json');
      assert.equal(options.dispatcher, dispatcher);
      assert.equal(connection.rejectUnauthorized, undefined);
      return Response.json({});
    },
  });
  connection.lookup('esa.unit-fixture.org', { all: true }, (error, addresses) => {
    assert.equal(error, null); assert.deepEqual(addresses, [{ address: '192.0.2.10', family: 4 }]);
  });
  connection.lookup('esa.unit-fixture.org', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '192.0.2.10'); assert.equal(family, 4);
  });
  await verifier.fetchImpl('https://esa.unit-fixture.org/release.json', { redirect: 'error' });
  await verifier.close(); assert.equal(closed, true);
  const ipv6 = createStagingVerifier('2001:db8::10', { agentFactory(options) {
    options.connect.lookup('esa.unit-fixture.org', {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '2001:db8::10'); assert.equal(family, 6);
    });
    return dispatcher;
  } });
  await ipv6.close();
  assert.throws(() => createStagingVerifier('not-an-ip'), /测试环境 IP/);
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-static-deploy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  const out = join(dir, 'out');
  await mkdir(dist); await mkdir(out);
  await writeFile(join(dist, 'index.html'), '<!doctype html>');
  await writeFile(join(dist, '404.html'), '<!doctype html>not found');
  const manifest = { version: 'static-test', site: { domain: config.site.domain }, db: { key: 'db/gallery-static-test.sqlite', size: 4096, sha256: 'a'.repeat(64) } };
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest));
  const configFile = join(dir, 'config.yaml');
  await writeFile(configFile, yaml.dump(config));
  const fakeNpm = join(dir, 'pnpm.mjs');
  await writeFile(fakeNpm, `import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const filename=process.argv.includes('esa-cli')?'esa.jsonc':'wrangler.jsonc';
const config=JSON.parse(readFileSync(join(process.cwd(),filename),'utf8'));
const proofFile=readdirSync(config.assets.directory).find(name=>/^pagehaven-deploy-[a-f0-9]{64}\\.json$/.test(name));
writeFileSync(process.env.TEST_LOG,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),config,proof:JSON.parse(readFileSync(join(config.assets.directory,proofFile),'utf8')),index:readFileSync(join(config.assets.directory,'index.html'),'utf8'),env:{ESA_PROJECT_NAME:process.env.ESA_PROJECT_NAME,WORKERS_DEPLOY_URL:process.env.WORKERS_DEPLOY_URL}}));
console.log(process.env.CLOUDFLARE_API_TOKEN||process.env.ESA_ACCESS_KEY_SECRET);
process.exit(Number(process.env.TEST_CLI_EXIT||0));`);
  const preload = join(dir, 'fetch.mjs');
  await writeFile(preload, `import {readFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import timers from 'node:timers/promises';
import {syncBuiltinESMExports} from 'node:module';
import {Agent,MockAgent} from ${JSON.stringify(pathToFileURL(join(ROOT, 'node_modules/undici/index.js')).href)};
timers.setTimeout=async()=>{};syncBuiltinESMExports();
const body=(path)=>{
  if(process.env.TEST_WRONG_ORIGIN==='1')return readFileSync(process.env.TEST_MARKER,'utf8');
  const seen=JSON.parse(readFileSync(process.env.TEST_LOG,'utf8'));
  return readFileSync(join(seen.config.assets.directory,basename(path)),'utf8');
};
const transport=new Agent();transport.dispatch=transport.dispatch.bind(transport);
const mock=new MockAgent({agent:transport});mock.disableNetConnect();
for(const origin of ['https://worker.unit-fixture.org','https://preview-worker.unit-fixture.org','https://esa.unit-fixture.org']){
  mock.get(origin).intercept({path:/^\\/pagehaven-deploy-[a-f0-9]{64}\\.json$/}).reply(200,({path})=>body(path)).persist();
}
Agent.prototype.dispatch=function(options,handler){return mock.dispatch(options,handler);};
globalThis.fetch=async(url)=>new Response(body(new URL(url).pathname));`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|EDGEONE_|ESA_|WORKERS_|ALIBABA_CLOUD_|DEPLOY_|RELEASE_|CONFIG_FILE$|DIST_DIR$|OUT_DIR$|NODE_OPTIONS$)/.test(key)) delete env[key];
  Object.assign(env, { CONFIG_FILE: configFile, DIST_DIR: dist, OUT_DIR: out, npm_execpath: fakeNpm, TEST_LOG: join(dir, 'cli.json'), TEST_MARKER: join(dist, 'release.json'), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
  return { dist, out, env, async marker(environment) { await writeFile(join(dist, 'release.json'), JSON.stringify({ version: manifest.version, fingerprint: releaseFingerprint(manifest), environment })); } };
}

function run(target, env) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts/deploy.mjs'), target], { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
}

test('两个新增平台使用隔离配置、绝对资源目录和环境凭据；匹配上线标记才写receipt并清理', async (t) => {
  const f = await fixture(t);
  for (const [target, secrets] of [['workers', workers], ['esa', esa]]) {
    for (const environment of ['production', 'preview']) {
      await f.marker(environment);
      const result = run(target, { ...f.env, ...secrets, DEPLOY_ENV: environment });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(!(result.stdout + result.stderr).includes('secret'));
      const seen = JSON.parse(await readFile(f.env.TEST_LOG, 'utf8'));
      assert.equal(seen.config.assets.directory, join(seen.cwd, 'assets'));
      assert.notEqual(seen.config.assets.directory, f.dist);
      assert.equal(seen.index, await readFile(join(f.dist, 'index.html'), 'utf8'));
      assert.equal(seen.proof.target, target);
      assert.equal(seen.proof.environment, environment);
      assert.equal(seen.config.main, undefined);
      assert.equal(seen.config.entry, undefined);
      assert.deepEqual(seen.env, {});
      assert.equal(seen.config.name, target === 'esa' ? esa.ESA_PROJECT_NAME : environment === 'preview' ? workers.CLOUDFLARE_PREVIEW_WORKER_NAME : workers.CLOUDFLARE_WORKER_NAME);
      assert.equal(JSON.parse(await readFile(join(f.out, `deployed-${target}.json`), 'utf8')).environment, environment);
      await assert.rejects(access(seen.cwd), { code: 'ENOENT' });
    }
  }
  assert.deepEqual((await inspectDeploymentFiles(f.dist)).map((file) => file.path).sort(), ['404.html', 'index.html', 'release.json']);
});

test('CLI退出0但验证地址落在旧平台时不写回执，并清理本次上传副本', async (t) => {
  const f = await fixture(t);
  await f.marker('production');
  for (const [target, secrets] of [['workers', workers], ['esa', esa]]) {
    await writeFile(join(f.out, `deployed-${target}.json`), '{}');
    const result = run(target, { ...f.env, ...secrets, TEST_WRONG_ORIGIN: '1' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /未记录部署成功/);
    await assert.rejects(access(join(f.out, `deployed-${target}.json`)), { code: 'ENOENT' });
    const seen = JSON.parse(await readFile(f.env.TEST_LOG, 'utf8'));
    await assert.rejects(access(seen.cwd), { code: 'ENOENT' });
  }
});

test('新端dry-run仍校验构建；超预算/CLI失败清除旧receipt，不上传不误记成功', async (t) => {
  const f = await fixture(t);
  let result = run('workers', { ...f.env, ...workers, DEPLOY_DRY_RUN: '1' });
  assert.notEqual(result.status, 0);
  await assert.rejects(access(f.env.TEST_LOG), { code: 'ENOENT' });
  await f.marker('production');
  result = run('workers', { ...f.env, ...workers, DEPLOY_DRY_RUN: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(access(f.env.TEST_LOG), { code: 'ENOENT' });
  await writeFile(join(f.out, 'deployed-workers.json'), '{}');
  result = run('workers', { ...f.env, ...workers, TEST_CLI_EXIT: '3' });
  assert.equal(result.status, 3);
  await assert.rejects(access(join(f.out, 'deployed-workers.json')), { code: 'ENOENT' });
  for (let i = 0; i < 1999; i++) await writeFile(join(f.dist, `${i}.html`), '');
  await writeFile(join(f.out, 'deployed-esa.json'), '{}');
  result = run('esa', { ...f.env, ...esa });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /超过上限 2000/);
  await assert.rejects(access(join(f.out, 'deployed-esa.json')), { code: 'ENOENT' });
});
