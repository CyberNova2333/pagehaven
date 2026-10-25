import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { generateAll, parseSiteConfig } from '../src/index.js';

const source = yaml.load(await readFile(new URL('../../../site.config.yaml', import.meta.url), 'utf8'));

test('旧配置未声明增强分页时保持关闭，显式布尔值可开启或关闭', () => {
  const config = structuredClone(source);
  delete config.features.comimi_reader;
  assert.equal(parseSiteConfig(yaml.dump(config)).features.comimi_reader, false);
  for (const enabled of [true, false]) {
    config.features.comimi_reader = enabled;
    assert.equal(parseSiteConfig(yaml.dump(config)).features.comimi_reader, enabled);
  }
});

test('增强分页开关拒绝字符串、数字和空值，避免配置误开启', () => {
  for (const invalid of ['true', 'false', 0, 1, null]) {
    const config = structuredClone(source);
    config.features.comimi_reader = invalid;
    assert.throws(() => parseSiteConfig(yaml.dump(config)), /features\.comimi_reader/);
  }
});

test('增强分页不改变平台响应头、重定向或配置生成物', async () => {
  const config = structuredClone(source);
  config.features.comimi_reader = false;
  const baseline = await generateAll(parseSiteConfig(yaml.dump(config)));
  config.features.comimi_reader = true;
  assert.deepEqual(await generateAll(parseSiteConfig(yaml.dump(config))), baseline);
  assert.deepEqual(Object.keys(baseline).sort(), ['_headers', '_redirects', 'edgeone.json']);
});
