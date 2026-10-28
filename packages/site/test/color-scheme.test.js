import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeColorScheme } from '../src/lib/color-scheme.js';

const KEY = 'pagehaven:color-scheme';
function fixture({ saved, dark = false, loading = false, unavailable = false, oldMedia = false, noControls = false, serialized = false } = {}) {
  const root = { dataset: {} };
  const values = new Map(saved === undefined ? [] : [[KEY, saved]]);
  const writes = [];
  const select = Object.assign(new EventTarget(), { value: 'system' });
  const control = { hidden: true };
  const status = { hidden: true, textContent: '' };
  const metas = ['light', 'dark'].map((scheme) => ({ dataset: { colorSchemeMeta: scheme }, setAttribute(key, value) { this[key] = value; } }));
  const doc = Object.assign(new EventTarget(), {
    documentElement: root, readyState: loading ? 'loading' : 'complete',
    querySelectorAll: (selector) => selector === '[data-color-scheme-meta]' ? metas : [],
    querySelector: () => noControls ? null : control,
    getElementById: (id) => noControls ? null : id === 'color-scheme-select' ? select : status,
  });
  const media = Object.assign(new EventTarget(), { matches: dark });
  if (oldMedia) {
    media.addListener = (listener) => EventTarget.prototype.addEventListener.call(media, 'change', listener);
    media.removeListener = (listener) => EventTarget.prototype.removeEventListener.call(media, 'change', listener);
    media.addEventListener = media.removeEventListener = undefined;
  }
  const f = { root, select, control, status, doc, media, values, writes, metas, readDenied: unavailable, writeDenied: unavailable };
  const storage = {
    getItem(key) { if (f.readDenied) throw new Error('denied'); return values.get(key) ?? null; },
    setItem(key, value) { if (f.writeDenied) throw new Error('quota'); writes.push([key, value]); values.set(key, value); },
  };
  const win = Object.assign(new EventTarget(), { localStorage: storage, CustomEvent, matchMedia: () => media });
  const changes = [];
  win.addEventListener('pagehaven:color-scheme-change', (event) => changes.push(event.detail));
  const init = serialized ? Function(`return (${initializeColorScheme.toString()})`)() : initializeColorScheme;
  const controller = init(win, doc);
  const choose = (value) => { select.value = value; select.dispatchEvent(new Event('change')); };
  const system = (value) => { media.matches = value; media.dispatchEvent(new Event('change')); };
  const stored = (key) => { const event = new Event('storage'); event.key = key; win.dispatchEvent(event); };
  return { ...f, win, controller, changes, choose, system, stored };
}

test('首屏同步脚本在正文加载前恢复偏好，序列化实现不依赖模块闭包', () => {
  const f = fixture({ saved: 'dark', loading: true, serialized: true });
  assert.deepEqual(f.root.dataset, { colorScheme: 'dark', resolvedColorScheme: 'dark' });
  assert.deepEqual(f.metas.map((meta) => meta.media), ['not all', 'all']);
  assert.equal(f.control.hidden, true);
  assert.deepEqual(f.writes, [], '读取偏好不能产生自动写入');
  f.doc.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(f.control.hidden, false);
  assert.equal(f.select.value, 'dark');
  assert.equal(f.status.hidden, true);
  assert.deepEqual(f.changes, [{ scheme: 'dark', preference: 'dark' }]);
});

test('默认跟随系统，手动选择优先；仅在实际颜色变化时通知阅读器', () => {
  const f = fixture();
  assert.equal(f.select.value, 'system');
  assert.equal(f.controller.scheme, 'light');
  f.system(true);
  assert.equal(f.controller.scheme, 'dark');
  f.choose('light');
  assert.equal(f.values.get(KEY), 'light');
  assert.equal(f.controller.scheme, 'light');
  f.system(false);
  f.system(true);
  assert.equal(f.controller.scheme, 'light');
  assert.equal(f.changes.length, 3);
  f.choose('system');
  assert.equal(f.controller.scheme, 'dark');
  assert.equal(f.values.get(KEY), 'system');
  assert.deepEqual(f.metas.map((meta) => meta.media), ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']);
  assert.ok(f.writes.every(([key]) => key === KEY), '不能写入其他个人数据');
});

test('跨标签页修改与清空、返回缓存页面时重新读取偏好，忽略无关键', () => {
  const f = fixture({ saved: 'light', dark: true });
  f.values.set(KEY, 'dark');
  f.stored('another-app:key');
  assert.equal(f.controller.scheme, 'light');
  f.stored(KEY);
  assert.equal(f.controller.scheme, 'dark');
  assert.equal(f.select.value, 'dark');
  f.values.delete(KEY);
  f.stored(null);
  assert.equal(f.select.value, 'system');
  f.values.set(KEY, 'light');
  f.win.dispatchEvent(new Event('pageshow'));
  assert.equal(f.controller.scheme, 'light');
  f.values.set(KEY, 'dark');
  f.win.dispatchEvent(new Event('focus'));
  assert.equal(f.controller.scheme, 'dark');
  assert.deepEqual(f.writes, []);
});

test('存储受限时本页手动选择有效，返回页面不丢失临时选择，重试后正常保存', () => {
  const f = fixture({ unavailable: true });
  assert.equal(f.status.hidden, false);
  f.choose('dark');
  assert.equal(f.controller.scheme, 'dark');
  f.win.dispatchEvent(new Event('pageshow'));
  f.system(false);
  f.values.set(KEY, 'light');
  f.stored(KEY);
  assert.equal(f.controller.scheme, 'dark');
  assert.match(f.status.textContent, /本页选择仍然有效/);
  // 恢复存储访问，重试同一选项应保存偏好并取消临时提示。
  f.win.localStorage = { getItem: (key) => f.values.get(key) ?? null, setItem: (key, value) => f.values.set(key, value) };
  f.choose('dark');
  assert.equal(f.values.get(KEY), 'dark');
  assert.equal(f.status.hidden, true);
  f.values.set(KEY, 'light');
  f.stored(KEY);
  assert.equal(f.controller.scheme, 'light');
});

test('非法偏好只会回退系统，旧媒体监听仍可用，销毁后不再响应', () => {
  const f = fixture({ saved: 'dark; background:url(x)', dark: true, oldMedia: true });
  assert.equal(f.controller.preference, 'system');
  assert.equal(f.controller.scheme, 'dark');
  f.system(false);
  assert.equal(f.controller.scheme, 'light');
  f.controller.destroy();
  f.system(true);
  f.choose('dark');
  f.values.set(KEY, 'dark');
  f.stored(KEY);
  f.win.dispatchEvent(new Event('pageshow'));
  assert.equal(f.controller.scheme, 'light');
  assert.deepEqual(f.writes, []);
});

test('缺少控件或系统探测失败时仍保留可用配色，加载前销毁不再绑定控件', () => {
  const f = fixture({ dark: true, noControls: true });
  assert.equal(f.controller.scheme, 'dark');
  const g = fixture({ loading: true });
  g.controller.destroy();
  g.doc.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(g.control.hidden, true);
  const root = { dataset: {} };
  const doc = { documentElement: root, readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, removeEventListener() {} };
  const win = Object.assign(new EventTarget(), { CustomEvent, matchMedia() { throw new Error('unsupported'); } });
  Object.defineProperty(win, 'localStorage', { get() { throw new Error('denied'); } });
  const controller = initializeColorScheme(win, doc);
  assert.equal(controller.scheme, 'light');
  controller.destroy();
});
