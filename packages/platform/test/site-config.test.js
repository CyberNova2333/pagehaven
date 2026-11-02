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
  assert.deepEqual(Object.keys(baseline).sort(), ['_headers', '_redirects', 'edgeone.json', 'esa.jsonc', 'wrangler.jsonc']);
});

test('旧配置缺少品牌与外观设置时沿用原站点外观，部分外观也补齐默认值', () => {
  const config = structuredClone(source);
  delete config.site.logo;
  delete config.site.tagline;
  delete config.appearance;
  const parsed = parseSiteConfig(yaml.dump(config));
  assert.equal(parsed.site.logo, '/favicon.svg');
  assert.equal(parsed.site.tagline, '在页间，遇见好故事');
  assert.deepEqual(parsed.appearance, { theme: 'paper', accent: '', font: 'serif', show_search: true, show_library: true });
  config.appearance = { theme: 'plum' };
  assert.deepEqual(parseSiteConfig(yaml.dump(config)).appearance, { ...parsed.appearance, theme: 'plum' });
});

test('站点外观接受受限的颜色、字体、Logo 与空页脚，不改变三平台配置产物', async () => {
  const config = parseSiteConfig(yaml.dump(source));
  const baseline = await generateAll(config);
  for (const theme of ['paper', 'ocean', 'plum']) {
    const custom = structuredClone(config);
    custom.site.logo = 'https://assets.example.org/site-logo';
    custom.site.tagline = '';
    custom.appearance = { theme, accent: '#Aa33CC', font: 'sans', show_search: false, show_library: false };
    const parsed = parseSiteConfig(yaml.dump(custom));
    assert.deepEqual(parsed.appearance, custom.appearance);
    assert.equal(parsed.site.tagline, '');
    assert.deepEqual(await generateAll(parsed), baseline);
  }
  config.site.logo = '/branding/site-logo.svg';
  assert.equal(parseSiteConfig(yaml.dump(config)).site.logo, '/branding/site-logo.svg');
});

test('品牌与外观设置拒绝脚本地址、路径绕过、任意 CSS、错误类型及未知键', () => {
  const cases = [
    ['site', 'logo', 'javascript:alert(1)'], ['site', 'logo', 'data:image/svg+xml,test'],
    ['site', 'logo', 'http://assets.example.org/logo.svg'], ['site', 'logo', '//assets.example.org/logo.svg'],
    ['site', 'logo', 'https://name:password@assets.example.org/logo.svg'],
    ['site', 'logo', '/branding/../logo.svg'], ['site', 'logo', '/branding/%2e%2e/logo.svg'],
    ['site', 'logo', 'https://assets.example.org/%0alogo.svg'], ['site', 'logo', '/logo.png'],
    ['site', 'tagline', 'x'.repeat(161)], ['site', 'tagline', '第一行\n第二行'],
    ['appearance', 'theme', 'custom'], ['appearance', 'font', 'external-font'],
    ['appearance', 'accent', '#fff'], ['appearance', 'accent', 'red'],
    ['appearance', 'accent', '#123456; background:url(https://assets.example.org/a)'],
    ['appearance', 'show_search', 'false'], ['appearance', 'show_library', 0],
    ['appearance', 'extra', true],
  ];
  for (const [section, field, value] of cases) {
    const config = parseSiteConfig(yaml.dump(source));
    config[section][field] = value;
    assert.throws(() => parseSiteConfig(yaml.dump(config)), undefined, `${section}.${field}: ${JSON.stringify(value)}`);
  }
});
