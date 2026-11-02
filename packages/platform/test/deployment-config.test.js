import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import {
  DEPLOY_TARGETS, DEFAULT_RELEASE_TARGETS, TARGET_CAPABILITIES,
  GENERATED_FILES, DEPLOY_CONFIG_FILES, generateAll, parseSiteConfig,
  renderWorkersDeployConfig, renderEsaDeployConfig,
} from '../src/index.js';

const source = yaml.load(await readFile(new URL('../../../site.config.yaml', import.meta.url), 'utf8'));
const parse = (value) => parseSiteConfig(yaml.dump(value));

test('旧三平台配置继续可读；新增目标默认保持纯静态且不带账号标识', () => {
  const old = structuredClone(source);
  delete old.deploy.workers;
  delete old.deploy.esa;
  const config = parse(old);
  assert.deepEqual(config.deploy.workers, { compatibility_date: '2026-11-02' });
  assert.deepEqual(config.deploy.esa, {});
  assert.deepEqual(DEFAULT_RELEASE_TARGETS, ['edgeone', 'esa', 'github', 'workers']);
  assert.ok(DEPLOY_TARGETS.includes('cloudflare'), '旧 Pages 目标必须单独保留');
  for (const target of DEPLOY_TARGETS) assert.ok(TARGET_CAPABILITIES[target]);
  assert.equal(TARGET_CAPABILITIES.github.previewSupported, false);
  assert.equal(TARGET_CAPABILITIES.esa.maxFiles, 2000);
  assert.equal(TARGET_CAPABILITIES.workers.maxFiles, 18000);
  assert.equal(TARGET_CAPABILITIES.github.maxTotalBytes, 1_000_000_000);
  assert.equal(TARGET_CAPABILITIES.esa.maxTotalBytes, 1_024_000_000);
});

test('部署控制模板可同步检查但不会出现在允许公开的响应配置清单里', async () => {
  const generated = await generateAll(parse(source));
  assert.deepEqual(Object.keys(generated).sort(), [...GENERATED_FILES, ...DEPLOY_CONFIG_FILES].sort());
  for (const filename of DEPLOY_CONFIG_FILES) {
    assert.ok(!GENERATED_FILES.includes(filename));
    const template = JSON.parse(generated[filename]);
    assert.equal(template.name, undefined);
    assert.equal(template.entry, undefined);
    assert.equal(template.main, undefined);
    assert.equal(template.assets.directory, '../../../dist');
  }
  assert.equal(JSON.parse(generated['wrangler.jsonc']).assets.not_found_handling, '404-page');
  assert.equal(JSON.parse(generated['esa.jsonc']).assets.notFoundStrategy, '404Page');
});

test('Workers 与 ESA 仅在部署时注入目标和路径，不修改配置或共享生成结果', async () => {
  const config = parse(source);
  const before = structuredClone(config);
  const templates = await generateAll(config);
  const worker = JSON.parse(renderWorkersDeployConfig(config, { directory: 'C:\\build output\\dist', name: 'reader-preview' }));
  assert.equal(worker.name, 'reader-preview');
  assert.equal(worker.assets.directory, 'C:\\build output\\dist');
  assert.equal(worker.assets.html_handling, 'auto-trailing-slash');
  assert.equal(worker.assets.run_worker_first, undefined);
  const esa = JSON.parse(renderEsaDeployConfig(config, { directory: '/tmp/build/dist', name: 'reader-preview' }));
  assert.equal(esa.name, 'reader-preview');
  assert.equal(esa.assets.directory, '/tmp/build/dist');
  assert.equal(esa.installCommand, '', '预构建产物不能在平台再次安装或构建');
  assert.equal(esa.buildCommand, '');
  assert.deepEqual(config, before);
  assert.deepEqual(await generateAll(config), templates);
});

test('兼容日期只从 YAML 获取，拒绝不存在的日期和额外平台绑定字段', () => {
  const changed = structuredClone(source);
  changed.deploy.workers = { compatibility_date: '2026-10-01' };
  assert.equal(JSON.parse(renderWorkersDeployConfig(parse(changed))).compatibility_date, '2026-10-01');
  for (const value of ['2026-02-30', '2026-13-01', '2026-1-01', '', 20261102, null]) {
    changed.deploy.workers = { compatibility_date: value };
    assert.throws(() => parse(changed), /deploy\.workers\.compatibility_date/);
  }
  for (const target of ['workers', 'esa']) {
    for (const field of ['name', 'account_id', 'api_token', 'entry', 'assets']) {
      const invalid = structuredClone(source);
      invalid.deploy[target][field] = 'unexpected';
      assert.throws(() => parse(invalid), undefined, `${target}.${field} 不能绕过纯静态部署契约`);
    }
  }
});

test('临时部署配置拒绝空目录、控制字符及无效项目名', () => {
  const config = parse(source);
  for (const render of [renderWorkersDeployConfig, renderEsaDeployConfig]) {
    for (const directory of ['', ' dist', 'dist\nother', null]) {
      assert.throws(() => render(config, { directory }), /静态产物目录/);
    }
    for (const name of ['', '../project', 'project\nother', 'project name', null]) {
      assert.throws(() => render(config, { name }), /项目标识/);
    }
  }
  assert.throws(() => renderWorkersDeployConfig(config, { name: 'UpperCase' }), /项目标识/);
  assert.throws(() => renderWorkersDeployConfig(config, { name: 'x'.repeat(64) }), /项目标识/);
});
