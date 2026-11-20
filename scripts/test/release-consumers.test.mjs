import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../lib/paths.mjs';
import yaml from 'js-yaml';
import { DEPLOY_TARGETS } from '@gallery/platform';

test('独立配置仍经 schema 校验，生产发布在构建和部署前拒绝占位图片域名', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-release-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = yaml.load(await readFile(join(ROOT, 'site.config.yaml'), 'utf8'));
  config.site.domain = 'gallery.unit-fixture.org';
  config.images.hosts = ['images.unit-fixture.org'];
  const configFile = join(dir, 'custom.yaml');
  const env = { ...process.env, CONFIG_FILE: 'custom.yaml', RELEASE_VERSION: 'safe-version', DEPLOY_TARGET: 'cloudflare', DEPLOY_ENV: 'production' };
  const check = () => spawnSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), 'check'], { cwd: dir, encoding: 'utf8', timeout: 10_000, env });
  await writeFile(configFile, yaml.dump(config));
  assert.equal(check().status, 0, 'CONFIG_FILE 相对路径基于调用目录，正确配置应通过');
  config.images.hosts = ['images.example.org'];
  await writeFile(configFile, yaml.dump(config));
  for (const args of [['release.mjs', 'check'], ['deploy.mjs', 'cloudflare']]) {
    const rejected = spawnSync(process.execPath, [join(ROOT, 'scripts', args[0]), args[1]], {
      cwd: dir, encoding: 'utf8', timeout: 10_000,
      env: { ...env, DIST_DIR: join(dir, 'not-built'), OUT_DIR: join(dir, 'no-outputs') },
    });
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.match(rejected.stdout + rejected.stderr, /正式图片域名/);
  }
  config.images.hosts = [];
  await writeFile(configFile, yaml.dump(config));
  const invalid = check();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout + invalid.stderr, /images.hosts/);
});

test('手动发布在构建前要求上传 Secrets，并且不输出原始密钥', () => {
  const complete = { R2_ACCOUNT_ID: 'account', R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret-sentinel', R2_BUCKET: 'bucket' };
  for (const extra of [{ R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '' }, complete]) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), 'check', '--require-secrets'], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CONFIG_FILE: '', RELEASE_VERSION: 'safe-version', DEPLOY_TARGET: 'none', DEPLOY_ENV: 'production', ...extra },
    });
    assert.equal(r.status, extra.R2_BUCKET ? 0 : 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /secret-sentinel/);
  }
});

test('发布参数检查在任何产物写入前拒绝不安全版本名与不支持的预览目标', () => {
  for (const env of [
    { RELEASE_VERSION: '../outside', DEPLOY_TARGET: 'none', DEPLOY_ENV: 'production' },
    { RELEASE_VERSION: 'safe-version', DEPLOY_TARGET: 'github', DEPLOY_ENV: 'preview' },
    { RELEASE_VERSION: 'safe-version', DEPLOY_TARGET: 'all', DEPLOY_ENV: 'preview' },
  ]) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), 'check'], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /只能是字母数字|不能选择 github 或 all/);
  }
});

test('预览与仅上传即使被单独调用，也不读取清单、写生产状态或发送搜索通知', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-release-consumers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statusFile = join(dir, 'STATUS.md');
  await writeFile(statusFile, '原生产状态');
  for (const mode of [{ DEPLOY_ENV: 'preview', DEPLOY_TARGET: 'edgeone' }, { DEPLOY_ENV: 'production', DEPLOY_TARGET: 'none' }]) {
    for (const script of ['write-status.mjs', 'seo-push.mjs']) {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, ...mode, OUT_DIR: join(dir, '不存在'), STATUS_FILE: statusFile },
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /预览或仅上传/);
    }
  }
  assert.equal(await readFile(statusFile, 'utf8'), '原生产状态');
});

test('GitHub 发布真实工作流：预检、部署、启用、工件及受限写回有序执行', async () => {
  const workflow = yaml.load(await readFile(join(ROOT, '.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.release.if, "${{ github.ref == 'refs/heads/main' }}");
  const steps = workflow.jobs.release.steps;
  assert.equal(steps[0].with.ref, '${{ github.sha }}');
  const scripts = steps.map((step) => step.run || '');
  const locate = (text) => scripts.findIndex((script) => script.includes(text));
  const preflight = locate('release:check --require-secrets');
  const upload = locate('pnpm run publish:r2');
  assert.ok(locate('refs/tags/last-green') < preflight && preflight >= 0 && preflight < locate('pnpm run build'));
  assert.ok(locate('pnpm run release:prepare') < upload);
  const guarded = steps.filter((step) => /pnpm run (release:activate|status|push:search)/.test(step.run || ''));
  assert.equal(guarded.length, 3);
  for (const step of guarded) assert.equal(step.if, "${{ env.DEPLOY_ENV == 'production' && env.DEPLOY_TARGET != 'none' }}");
  const activation = locate('pnpm run release:activate');
  for (const target of DEPLOY_TARGETS) assert.ok(upload < locate(`pnpm run deploy:${target}`) && locate(`pnpm run deploy:${target}`) < activation, target);
  const archive = steps.findIndex((step) => step.id === 'writeback_artifact');
  const writeback = locate('scripts/ci/release-writeback.mjs');
  assert.ok(archive >= 0 && archive < writeback);
  assert.match(steps[archive].if, /always\(\)/);
  assert.match(steps[writeback].if, /writeback_artifact.outcome == 'success'/);
  assert.equal(steps[writeback].env.RELEASE_SIGNING_KEY, '${{ secrets.RELEASE_SIGNING_KEY }}');
  assert.doesNotMatch(scripts.join('\n'), /skip-hooks|git pull|git push.*--force|git commit/);
});
