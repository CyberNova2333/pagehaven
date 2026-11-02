import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeploymentName, renderWorkersDeployConfig, renderEsaDeployConfig } from '../src/index.js';

const config = { deploy: { workers: { compatibility_date: '2026-11-02' } } };

test('Workers 配置使用 DNS 名称边界：允许单字符和 63 字符，拒绝首尾连字符', () => {
  for (const name of ['a', '0', 'fixture-production', 'a--b', 'x'.repeat(63)]) {
    assert.equal(isDeploymentName('workers', name), true);
    assert.equal(JSON.parse(renderWorkersDeployConfig(config, { name })).name, name);
  }
  for (const name of ['', '-fixture', 'fixture-', '-', 'x'.repeat(64), 'Fixture', 'a_b', 'a\n', 123, null]) {
    assert.equal(isDeploymentName('workers', name), false);
    assert.throws(() => renderWorkersDeployConfig(config, { name }), /项目标识/);
  }
});

test('ESA 保留自己的名称规则，不能被 Workers DNS 限制意外收紧', () => {
  for (const name of ['a', 'Fixture_Production', 'fixture-', 'X'.repeat(128)]) {
    assert.equal(isDeploymentName('esa', name), true);
    assert.equal(JSON.parse(renderEsaDeployConfig(config, { name })).name, name);
  }
  for (const name of ['', '-fixture', 'a/b', 'x'.repeat(129), null]) {
    assert.equal(isDeploymentName('esa', name), false);
    assert.throws(() => renderEsaDeployConfig(config, { name }), /项目标识/);
  }
  assert.equal(isDeploymentName('unknown', 'fixture'), false);
});
