// 构建页面与维护者预览共用同一套受限外观设置，不接受任意 CSS。
export const THEMES = Object.freeze({
  paper: Object.freeze({ name: '纸间青绿', label: '纸间青绿', accent: '#28776e' }),
  ocean: Object.freeze({ name: '晴海墨蓝', label: '晴海墨蓝', accent: '#315f94' }),
  plum: Object.freeze({ name: '暮色梅紫', label: '暮色梅紫', accent: '#845273' }),
});

const PALETTES = {
  paper: {
    top: '#faf8f1', mid: '#f4f1e9', low: '#edf2ed', surface: '#fffdf7', soft: '#f4f0e6',
    ink: '#203540', text: '#394d55', dim: '#61706d', strong: '#19574f', alt: '#355d72',
    accentSoft: '#dcece5', highlight: '#a47730', coverFrom: '#e2ece5', coverTo: '#e7e9df',
    glowOne: 'rgba(201, 214, 193, 0.25)', glowTwo: 'rgba(180, 205, 198, 0.2)', glowThree: 'rgba(207, 213, 196, 0.16)',
  },
  ocean: {
    top: '#f5f8fc', mid: '#edf2f8', low: '#e8eff6', surface: '#fcfdff', soft: '#edf2f9',
    ink: '#213448', text: '#394d64', dim: '#5f7185', strong: '#244d7a', alt: '#315f78',
    accentSoft: '#dce7f4', highlight: '#8c692f', coverFrom: '#dae6f4', coverTo: '#e4eef1',
    glowOne: 'rgba(184, 205, 233, 0.25)', glowTwo: 'rgba(188, 216, 226, 0.2)', glowThree: 'rgba(197, 208, 230, 0.16)',
  },
  plum: {
    top: '#fbf7fa', mid: '#f3edf3', low: '#eee8f1', surface: '#fffcff', soft: '#f4edf5',
    ink: '#3c2b40', text: '#554258', dim: '#77637a', strong: '#6b3e5d', alt: '#665080',
    accentSoft: '#efdeeb', highlight: '#90682d', coverFrom: '#ecdeeb', coverTo: '#e7e0ef',
    glowOne: 'rgba(220, 191, 213, 0.25)', glowTwo: 'rgba(200, 190, 219, 0.2)', glowThree: 'rgba(220, 203, 215, 0.16)',
  },
};

const DARK_PALETTES = {
  paper: {
    top: '#16221f', mid: '#182723', low: '#1b2d27', surface: '#20332c', soft: '#293f35',
    ink: '#e6efe5', text: '#d1dfd2', dim: '#a7baac', strong: '#8bd2b8', alt: '#a6c7df',
    accentSoft: '#294c3d', highlight: '#e6b86a', coverFrom: '#2b4337', coverTo: '#354336', reader: '#121d18',
    glowOne: 'rgba(86, 119, 82, 0.12)', glowTwo: 'rgba(61, 114, 99, 0.1)', glowThree: 'rgba(80, 110, 84, 0.1)',
  },
  ocean: {
    top: '#142031', mid: '#17273a', low: '#1b3044', surface: '#20374c', soft: '#294157',
    ink: '#e6effa', text: '#d3e1ef', dim: '#a9bed4', strong: '#9bc7ff', alt: '#98cfdf',
    accentSoft: '#294969', highlight: '#e9bd72', coverFrom: '#2c435f', coverTo: '#304e5b', reader: '#101a27',
    glowOne: 'rgba(69, 102, 148, 0.12)', glowTwo: 'rgba(65, 112, 134, 0.1)', glowThree: 'rgba(75, 92, 135, 0.1)',
  },
  plum: {
    top: '#241c2a', mid: '#2a2131', low: '#30243a', surface: '#382b40', soft: '#44324b',
    ink: '#f4e8f3', text: '#e3d2e3', dim: '#c5acc7', strong: '#e4b1d3', alt: '#cdb9ee',
    accentSoft: '#523850', highlight: '#e6bf7c', coverFrom: '#50364f', coverTo: '#473952', reader: '#1b1422',
    glowOne: 'rgba(128, 79, 117, 0.12)', glowTwo: 'rgba(96, 78, 134, 0.1)', glowThree: 'rgba(121, 89, 114, 0.1)',
  },
};

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
  const target = minimum('#ffffff') > minimum('#000000') ? '#ffffff' : '#000000';
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
  const onAccent = contrast(accent, '#ffffff') >= contrast(accent, '#000000') ? '#ffffff' : '#000000';
  const reader = palette.reader ?? '#192a33';
  const shadow = dark ? '#000000' : palette.ink;
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
    '--text-overlay-foreground': '#fffdf7',
    '--highlight-ring': rgba(palette.highlight, 0.3),
    '--shadow': `0 10px 34px ${rgba(shadow, dark ? 0.24 : 0.07)}`,
    '--shadow-hover': `0 12px 30px ${rgba(shadow, dark ? 0.36 : 0.12)}`,
    '--glow-one': palette.glowOne,
    '--glow-two': palette.glowTwo,
    '--glow-three': palette.glowThree,
    '--font-heading': appearance.font === 'sans' ? 'var(--font-sans)' : 'var(--font-serif)',
  };
}
