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

test('手动发布密钥参数缺失时明确失败，仅上传也必须提供上传密钥地址', () => {
  for (const publishUrl of ['', 'https://cnb.cool/unit-group/unit-secrets/-/blob/main/publish.yml']) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), 'check', '--require-secret-imports'], {
      cwd: ROOT, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CONFIG_FILE: '', RELEASE_VERSION: 'safe-version', DEPLOY_TARGET: 'none', DEPLOY_ENV: 'production',
        publish_secrets_url: publishUrl, deploy_secrets_url: '' },
    });
    assert.equal(r.status, publishUrl ? 0 : 1, r.stdout + r.stderr);
    if (!publishUrl) assert.match(r.stdout + r.stderr, /publish_secrets_url/);
    assert.doesNotMatch(r.stdout + r.stderr, /unit-secrets/);
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

test('发布流水线的真实条件：只有已选择目标的生产发布执行启用、状态与SEO步骤', async () => {
  const pipeline = yaml.load(await readFile(join(ROOT, '.cnb.yml'), 'utf8')).main.web_trigger_release[0];
  const guarded = pipeline.stages.filter((stage) => /npm run (release:activate|status|push:search)/.test(stage.script ?? ''));
  assert.equal(guarded.length, 3);
  for (const environment of ['production', 'preview']) {
    for (const target of ['none', ...DEPLOY_TARGETS, 'all']) {
      for (const stage of guarded) {
        const r = spawnSync('sh', ['-c', stage.if], {
          env: { ...process.env, DEPLOY_ENV: environment, DEPLOY_TARGET: target }, encoding: 'utf8', timeout: 5000,
        });
        assert.ifError(r.error);
        assert.equal(r.status, environment === 'production' && target !== 'none' ? 0 : 1, `${stage.name} / ${environment} / ${target}: ${r.stderr}`);
      }
    }
  }
  const scripts = pipeline.stages.map((stage) => stage.script ?? '');
  assert.ok(scripts.some((script) => script.includes('npm run release:check -- --require-secret-imports')));
  const firstImport = pipeline.stages.findIndex((stage) => stage.imports);
  assert.ok(scripts.findIndex((script) => script.includes('--require-secret-imports')) < firstImport, '缺少密钥地址应在首次导入前明确失败');
  const urls = new Set(pipeline.stages.map((stage) => stage.imports).filter(Boolean));
  assert.deepEqual([...urls].sort(), ['${deploy_secrets_url}', '${publish_secrets_url}']);
  assert.ok(scripts.findIndex((script) => script.includes('npm run release:prepare')) < scripts.indexOf('npm run publish:r2'));
  const activation = scripts.indexOf('npm run release:activate');
  for (const target of DEPLOY_TARGETS) assert.ok(scripts.indexOf(`npm run deploy:${target}`) < activation);
});
