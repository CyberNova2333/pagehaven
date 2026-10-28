import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, appearanceVariables } from '../src/lib/site-appearance.js';

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(left, right) {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

test('站点外观：旧配置保持纸色青绿，三套主题共用完整变量契约', () => {
  const current = appearanceVariables();
  assert.equal(current['--accent'], '#28776e');
  assert.equal(current['--surface'], '#fffdf7');
  assert.equal(current['--ink'], '#203540');
  assert.equal(current['--font-heading'], 'var(--font-serif)');
  for (const [theme, { label, accent }] of Object.entries(THEMES)) {
    assert.ok(label);
    const variables = appearanceVariables({ theme });
    assert.deepEqual(Object.keys(variables), Object.keys(current));
    assert.equal(variables['--accent'], accent);
    for (const text of ['--ink', '--text', '--text-dim', '--accent-strong', '--accent-alt']) {
      assert.ok(contrast(variables[text], variables['--surface']) >= 4.5, `${theme} ${text} 对比不足`);
    }
  }
});

test('站点外观：极浅与极深自定义色保留按钮主色，自动选择可读文字和链接色', () => {
  for (const theme of Object.keys(THEMES)) {
    for (const accent of ['#ffffff', '#FFFF00', '#000000', '#00ff00', '#8800aa', '#123456']) {
      const variables = appearanceVariables({ theme, accent });
      assert.equal(variables['--accent'], accent.toLowerCase());
      assert.ok(contrast(variables['--accent'], variables['--on-accent']) >= 4.5);
      assert.ok(contrast(variables['--accent-strong'], variables['--surface']) >= 4.5);
      assert.ok(contrast(variables['--accent-alt'], variables['--surface']) >= 4.5);
    }
  }
});

test('站点外观：不接受任意 CSS，未知主题安全回退且字体只取预设', () => {
  assert.deepEqual(appearanceVariables({ theme: 'unknown', accent: 'red; background:url(x)', font: 'url(x)' }), appearanceVariables());
  assert.deepEqual(appearanceVariables({ theme: '__proto__' }), appearanceVariables());
  const sans = appearanceVariables({ font: 'sans' });
  assert.equal(sans['--font-heading'], 'var(--font-sans)');
  assert.notEqual(sans['--font-heading'], appearanceVariables()['--font-heading']);
});
