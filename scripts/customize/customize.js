import { appearanceVariables, THEMES } from '/site-appearance.js';

const form = document.querySelector('#settings-form');
const fields = document.querySelector('#settings-fields');
const save = document.querySelector('#save');
const reset = document.querySelector('#reset');
const reload = document.querySelector('#reload');
const status = document.querySelector('#status');
const saveState = document.querySelector('#save-state');
const preview = document.querySelector('#site-preview');
const picker = document.querySelector('#accent-picker');
const token = new URLSearchParams(location.hash.slice(1)).get('token');
let baseline;
let revision;
let busy = false;
let dirty = false;
let logoSource = '';
const names = ['title', 'logo', 'tagline', 'theme', 'accent', 'font', 'showSearch', 'showLibrary', 'textLayer', 'enhancedReader'];
const booleans = new Set(['showSearch', 'showLibrary', 'textLayer', 'enhancedReader']);

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function collect() {
  return Object.fromEntries(names.map((name) => [name, booleans.has(name) ? form.elements[name].checked : form.elements[name].value]));
}

function populate(settings) {
  for (const name of names) {
    if (booleans.has(name)) form.elements[name].checked = settings[name];
    else form.elements[name].value = settings[name];
  }
}

function update() {
  const settings = collect();
  dirty = Boolean(baseline && names.some((name) => baseline[name] !== settings[name]));
  save.disabled = busy || !baseline || !dirty;
  reset.disabled = busy || !dirty;
  saveState.textContent = busy ? '正在保存…' : dirty ? '有未保存的修改' : baseline ? '已保存' : '尚未连接';
  saveState.classList.toggle('dirty', dirty);
  const accent = /^#[\da-f]{6}$/i.test(settings.accent) ? settings.accent : '';
  for (const [property, value] of Object.entries(appearanceVariables({ theme: settings.theme, accent, font: settings.font }))) preview.style.setProperty(property, value);
  picker.value = accent || THEMES[settings.theme]?.accent || '#28776e';
  document.querySelector('#preview-title').textContent = settings.title || '你的站点';
  document.querySelector('#preview-tagline').textContent = settings.tagline;
  for (const [name, id] of [['showLibrary', 'library'], ['showSearch', 'search'], ['textLayer', 'text-layer'], ['enhancedReader', 'enhanced-reader']]) document.querySelector(`#preview-${id}`).hidden = !settings[name];
  if (logoSource !== settings.logo) {
    logoSource = settings.logo;
    const img = document.querySelector('#preview-logo');
    let valid = false;
    try {
      const url = new URL(settings.logo, location.origin);
      valid = !/[\s\\]/.test(settings.logo) && !url.username && !url.password && (url.protocol === 'https:' || (settings.logo.startsWith('/') && !settings.logo.startsWith('//')));
    } catch { /* 尚未输入完整地址时保留默认图标。 */ }
    img.src = valid ? settings.logo : '/favicon.svg';
    document.querySelector('#preview-note').textContent = '这里预览颜色、字体和品牌。实际漫画内容以站点数据为准。';
  }
}

document.querySelector('#preview-logo').addEventListener('error', (event) => {
  // 配置中的站内图标可能尚未出现在临时编辑器中，保存值不因此改变。
  if (event.target.getAttribute('src') !== '/favicon.svg') event.target.src = '/favicon.svg';
  document.querySelector('#preview-note').textContent = 'Logo 暂时无法在编辑器中显示。请确认图片可访问；站内图片会在重新构建后加载。';
});

async function request(method = 'GET', body) {
  const response = await fetch('/api/settings', {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '无法保存设置，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function load() {
  if (busy) return;
  if (!token) { message('请使用启动工具输出的完整链接打开此页面，其中包含本次编辑所需的访问标记。', true); return; }
  busy = true;
  fields.disabled = true;
  save.disabled = true;
  reset.disabled = true;
  reload.disabled = true;
  reload.hidden = true;
  saveState.textContent = '正在读取…';
  message('正在读取已保存的设置…');
  let loaded = false;
  try {
    const result = await request();
    baseline = result.settings;
    revision = result.revision;
    populate(baseline);
    loaded = true;
    message('已读取站点配置。修改后可在此保存。');
  } catch (error) {
    message(error.name === 'TimeoutError' ? '连接超时，请确认编辑工具仍在运行。' : error.message, true);
    reload.hidden = false;
    saveState.textContent = '连接失败';
  } finally {
    busy = false;
    reload.disabled = false;
    if (loaded) { fields.disabled = false; update(); }
  }
}

form.addEventListener('input', () => { if (baseline) update(); });
form.addEventListener('change', () => { if (baseline) update(); });
picker.addEventListener('input', () => { form.elements.accent.value = picker.value; update(); });
document.querySelector('#reset-accent').addEventListener('click', () => { form.elements.accent.value = ''; update(); });
reset.addEventListener('click', () => { populate(baseline); update(); message('已撤销本页修改，恢复为上次读取或保存的设置。'); });
reload.addEventListener('click', load);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !baseline || !dirty || !form.reportValidity()) return;
  const settings = collect();
  if (!settings.title.trim()) { message('站点名称不能为空。', true); form.elements.title.focus(); return; }
  busy = true;
  fields.disabled = true;
  reload.disabled = true;
  update();
  message('正在校验并保存设置…');
  try {
    const result = await request('POST', { settings, revision });
    baseline = result.settings;
    revision = result.revision;
    populate(baseline);
    reload.hidden = true;
    message('已保存到站点配置。重新构建并手动发布后，对全部读者生效。');
  } catch (error) {
    if (error.status === 409) {
      reload.hidden = false;
      message('配置已被其他窗口或工具修改。本页修改尚未保存；重新读取最新配置后再编辑。', true);
    } else {
      if (error.name === 'TimeoutError' || !error.status) reload.hidden = false;
      message(error.name === 'TimeoutError' ? '保存结果暂未确认，请重新读取配置后核对。' : error.message, true);
    }
  } finally {
    busy = false;
    fields.disabled = false;
    reload.disabled = false;
    update();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (dirty || busy) { event.preventDefault(); event.returnValue = ''; }
});
for (const [property, value] of Object.entries(appearanceVariables())) preview.style.setProperty(property, value);
load();
