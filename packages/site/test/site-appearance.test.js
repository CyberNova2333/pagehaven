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
  assert.equal(current['--color-scheme'], 'light');
  assert.equal(current['--text-overlay'], 'rgba(25, 42, 51, 0.88)');
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
    for (const scheme of ['light', 'dark']) {
      for (const accent of ['#ffffff', '#FFFF00', '#000000', '#00ff00', '#8800aa', '#123456']) {
        const variables = appearanceVariables({ theme, accent }, scheme);
        assert.equal(variables['--accent'], accent.toLowerCase());
        assert.ok(contrast(variables['--accent'], variables['--on-accent']) >= 4.5);
        for (const surface of ['--bg-top', '--bg-mid', '--bg-low', '--surface', '--surface-soft']) {
          for (const link of ['--accent-strong', '--accent-alt']) {
            assert.ok(contrast(variables[link], variables[surface]) >= 4.5, `${theme}/${scheme}/${accent} ${link} 在 ${surface} 上对比不足`);
          }
        }
      }
    }
  }
});

test('站点外观：三套深色主题覆盖完整语义变量，正文与链接在各类表面保持对比', () => {
  const light = appearanceVariables();
  for (const theme of Object.keys(THEMES)) {
    const dark = appearanceVariables({ theme }, 'dark');
    const sameThemeLight = appearanceVariables({ theme });
    assert.deepEqual(Object.keys(dark), Object.keys(light));
    assert.equal(dark['--color-scheme'], 'dark');
    for (const surface of ['--bg-top', '--bg-mid', '--bg-low', '--surface', '--surface-soft']) {
      assert.ok(luminance(dark[surface]) < 0.1, `${theme} ${surface} 应保持深色`);
      for (const text of ['--ink', '--text', '--text-dim', '--accent-strong', '--accent-alt']) {
        assert.ok(contrast(dark[text], dark[surface]) >= 4.5, `${theme} ${text} 在 ${surface} 上对比不足`);
      }
    }
    for (const variable of ['--bg-top', '--bg-mid', '--bg-low', '--surface', '--surface-soft', '--ink', '--text', '--text-dim', '--line', '--glow-one', '--cover-bg', '--shadow', '--reader-bg']) {
      assert.notEqual(dark[variable], sameThemeLight[variable], `${theme} ${variable} 应适配深色`);
    }
    assert.match(dark['--shadow'], /rgba\(0, 0, 0, /, '深色阴影不使用浅色文字产生白色光晕');
    assert.ok(contrast(dark['--text-overlay-foreground'], dark['--reader-bg']) >= 4.5, '深色文字标注必须使用浅色前景');
  }
});

test('站点外观：不接受任意 CSS，未知主题安全回退且字体只取预设', () => {
  assert.deepEqual(appearanceVariables({ theme: 'unknown', accent: 'red; background:url(x)', font: 'url(x)' }), appearanceVariables());
  assert.deepEqual(appearanceVariables({ theme: '__proto__' }), appearanceVariables());
  const sans = appearanceVariables({ font: 'sans' });
  assert.equal(sans['--font-heading'], 'var(--font-sans)');
  assert.notEqual(sans['--font-heading'], appearanceVariables()['--font-heading']);
  for (const scheme of [undefined, null, '', 'system', 'DARK', 'dark; background:url(x)']) {
    assert.deepEqual(appearanceVariables({}, scheme), appearanceVariables(), '仅精确 dark 值可以启用深色变量');
  }
  assert.deepEqual(appearanceVariables({ theme: '__proto__', accent: 'url(x)' }, 'dark'), appearanceVariables({}, 'dark'));
  assert.equal(appearanceVariables({ font: 'sans' }, 'dark')['--font-heading'], 'var(--font-sans)');
});
