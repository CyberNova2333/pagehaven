// 构建页面与维护者预览共用同一套受限外观设置，不接受任意 CSS。
// 兼容既有配置 ID；三种密度都从 Enterprise 色板派生，不增加平台能力。
export const THEMES = Object.freeze({
  paper: Object.freeze({ name: '品牌蓝 · 轻纸', label: '品牌蓝 · 轻纸', accent: '#0c5cab' }),
  ocean: Object.freeze({ name: '品牌蓝 · 雾面', label: '品牌蓝 · 雾面', accent: '#0c5cab' }),
  plum: Object.freeze({ name: '品牌蓝 · 墨面', label: '品牌蓝 · 墨面', accent: '#0a4a8a' }),
});
const light = {
  top: '#fafafa', mid: '#fafafa', low: '#eeeeef', surface: '#eeeeef', soft: '#e7e7e8',
  ink: '#09090b', text: '#303032', dim: '#626263', strong: '#0c5cab', alt: '#0a4a8a',
  accentSoft: '#e2eaf2', highlight: '#f59e0b', coverFrom: '#e2eaf2', coverTo: '#eeeeef', reader: '#09090b',
  glowOne: 'transparent', glowTwo: 'transparent', glowThree: 'transparent',
};
const dark = {
  top: '#09090b', mid: '#09090b', low: '#161618', surface: '#161618', soft: '#222224',
  ink: '#fafafa', text: '#ddddde', dim: '#b2b2b3', strong: '#97bddf', alt: '#fafafa',
  accentSoft: '#0a2440', highlight: '#f59e0b', coverFrom: '#0a2440', coverTo: '#161618', reader: '#09090b',
  glowOne: 'transparent', glowTwo: 'transparent', glowThree: 'transparent',
};
const PALETTES = { paper: light, ocean: { ...light, surface: '#e2eaf2' }, plum: { ...light, surface: '#e7e7e8' } };
const DARK_PALETTES = { paper: dark, ocean: { ...dark, surface: '#0a2440' }, plum: { ...dark, surface: '#1c1c1e' } };

const rgb = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
const rgba = (hex, opacity) => `rgba(${rgb(hex).join(', ')}, ${opacity})`;
const mix = (left, right, amount) => '#' + rgb(left).map((value, index) =>
  Math.round(value * (1 - amount) + rgb(right)[index] * amount).toString(16).padStart(2, '0')).join('');

function luminance(hex) {
  const channels = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function linkColor(accent, surfaces) {
  let color = accent;
  const minimum = (candidate) => Math.min(...surfaces.map((surface) => contrast(candidate, surface)));
  const target = minimum('#fafafa') > minimum('#09090b') ? '#fafafa' : '#09090b';
  // 主色保留作按钮底色，链接针对实际表面向黑或白调整，深浅背景均保持可读性。
  for (let i = 0; i < 24 && minimum(color) < 4.5; i++) color = mix(color, target, 0.1);
  return color;
}

/** 完整语义变量，用于 Astro 的 style 对象或浏览器 style.setProperty。 */
export function appearanceVariables(appearance = {}, scheme = 'light') {
  const dark = scheme === 'dark';
  const theme = Object.hasOwn(PALETTES, appearance.theme) ? appearance.theme : 'paper';
  const palette = (dark ? DARK_PALETTES : PALETTES)[theme];
  const customAccent = typeof appearance.accent === 'string' && /^#[a-f\d]{6}$/i.test(appearance.accent);
  const accent = customAccent ? appearance.accent.toLowerCase() : THEMES[theme].accent;
  const surfaces = [palette.top, palette.mid, palette.low, palette.surface, palette.soft];
  const strong = customAccent ? linkColor(mix(accent, palette.ink, 0.25), surfaces) : palette.strong;
  const onAccent = contrast(accent, '#fafafa') >= contrast(accent, '#09090b') ? '#fafafa' : '#09090b';
  const reader = palette.reader ?? '#09090b';
  return {
    '--color-scheme': dark ? 'dark' : 'light',
    '--bg-top': palette.top,
    '--bg-mid': palette.mid,
    '--bg-low': palette.low,
    '--accent': accent,
    '--accent-strong': strong,
    '--accent-soft': customAccent ? mix(accent, palette.surface, 0.84) : palette.accentSoft,
    '--accent-alt': customAccent ? strong : palette.alt,
    '--on-accent': onAccent,
    '--highlight': palette.highlight,
    '--ink': palette.ink,
    '--text': palette.text,
    '--text-dim': palette.dim,
    '--line': rgba(palette.ink, 0.16),
    '--surface': palette.surface,
    '--surface-soft': palette.soft,
    '--surface-raised': rgba(palette.surface, 0.95),
    '--cover-bg': `linear-gradient(135deg, ${palette.coverFrom}, ${palette.coverTo})`,
    '--selection': rgba(accent, 0.24),
    '--focus-ring': rgba(strong, 0.18),
    '--reader-bg': reader,
    '--text-overlay': rgba(reader, 0.88),
    '--text-overlay-foreground': '#fafafa',
    '--highlight-ring': rgba(palette.highlight, 0.3),
    '--shadow': 'none',
    '--shadow-hover': 'none',
    '--glow-one': palette.glowOne,
    '--glow-two': palette.glowTwo,
    '--glow-three': palette.glowThree,
    '--font-heading': appearance.font === 'sans' ? 'var(--font-sans)' : 'var(--font-serif)',
  };
}
