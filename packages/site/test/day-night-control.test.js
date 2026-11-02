import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { initializeColorScheme } from '../src/lib/color-scheme.js';
import { mountDayNightControl } from '../src/lib/day-night-control.js';

const source = await readFile(new URL('../public/day-night-switch.js', import.meta.url), 'utf8');
const KEY = 'pagehaven:color-scheme';

// 最小 DOM 夹具运行真实公开脚本和旧配色控制器；不把开关自身替换成 mock。
class Element extends EventTarget {
  constructor() {
    super();
    this.children = [];
    this.attributes = new Map();
    this.style = { removeProperty(name) { delete this[name]; } };
    this.className = '';
    this.dataset = {};
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
    };
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  insertBefore(child, sibling) { this.children.splice(this.children.indexOf(sibling), 0, child); child.parentNode = this; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  attachShadow() { this.shadow = new Element(); return this.shadow; }
  querySelectorAll(selector) {
    const elements = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
    return selector === '*' ? elements : elements.filter((child) => child.className.split(' ').includes(selector.slice(1)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  // 只需构建公开脚本固定的 div 装饰树；不实现任意 HTML 执行。
  set innerHTML(html) {
    const stack = [this];
    for (const token of html.matchAll(/<(\/?)div\b([^>]*)>/g)) {
      if (token[1]) { stack.pop(); continue; }
      const element = new Element();
      element.className = /class="([^"]*)"/.exec(token[2])?.[1] ?? '';
      stack.at(-1).appendChild(element);
      stack.push(element);
    }
  }
  insertAdjacentHTML() { /* 飞机和小熊 SVG 不参与配色状态或交互。 */ }
}

function fixture({ dark = false, reduced = false, loading = false } = {}) {
  const root = new Element();
  const parent = new Element();
  const control = parent.appendChild(new Element());
  control.hidden = true;
  const select = control.appendChild(new Element());
  select.value = 'system';
  const status = new Element();
  const values = new Map();
  const writes = [];
  const timeouts = new Map();
  const intervals = new Map();
  let timerId = 0;
  const media = Object.assign(new EventTarget(), { matches: dark });
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  const win = Object.assign(new EventTarget(), {
    Event, CustomEvent,
    matchMedia: (query) => query.includes('reduced-motion') ? motion : media,
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem(key, value) { values.set(key, value); writes.push([key, value]); },
    },
  });
  const doc = Object.assign(new EventTarget(), {
    documentElement: root, readyState: loading ? 'loading' : 'complete',
    createElement: () => new Element(),
    getElementById: (id) => id === 'color-scheme-select' ? select : status,
    querySelector: () => control,
    querySelectorAll: () => [],
  });
  runInNewContext(source, {
    window: win, document: doc,
    setTimeout(fn) { timeouts.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { intervals.set(++timerId, fn); return timerId; },
    clearInterval(id) { intervals.delete(id); },
  });
  const colors = initializeColorScheme(win, doc);
  const scene = mountDayNightControl(win, doc);
  const host = () => parent.querySelector('.dn-host');
  const shadow = () => host().children[0].children[0].shadow;
  const choose = (value) => { select.value = value; select.dispatchEvent(new Event('change')); };
  const system = (value) => { media.matches = value; media.dispatchEvent(new Event('change')); };
  const stored = (value) => {
    values.set(KEY, value);
    const event = new Event('storage'); event.key = KEY; win.dispatchEvent(event);
  };
  const flush = () => { for (const fn of timeouts.values()) fn(); timeouts.clear(); };
  return { root, control, select, doc, win, values, writes, timeouts, intervals, colors, scene, host, shadow, choose, system, stored, flush, motion };
}

test('真实昼夜开关保留三态入口，系统与跨标签修改同步可见状态及无障碍状态', () => {
  const f = fixture({ loading: true });
  assert.equal(f.host(), null);
  f.doc.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(f.control.hidden, false);
  assert.notEqual(f.control.style.display, 'none');
  assert.equal(f.select.value, 'system');
  assert.equal(f.host().getAttribute('aria-checked'), 'false');
  f.system(true);
  assert.equal(f.host().getAttribute('aria-checked'), 'true');
  assert.equal(f.shadow().querySelector('.container').className, 'container is-night');
  f.host().dispatchEvent(new Event('click'));
  assert.equal(f.select.value, 'light');
  assert.equal(f.values.get(KEY), 'light');
  f.choose('system');
  assert.equal(f.host().getAttribute('aria-checked'), 'true');
  f.stored('light');
  assert.equal(f.host().getAttribute('aria-checked'), 'false');
  assert.equal(f.shadow().querySelector('.container').className, 'container is-day');
  f.scene.destroy(); f.colors.destroy();
});

test('键盘操作立即交给旧状态源，不会用延迟写入覆盖之后的跨标签选择', () => {
  const f = fixture();
  for (const key of ['Enter', ' ']) {
    const event = new Event('keydown', { cancelable: true }); event.key = key;
    f.host().dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(f.writes, [[KEY, 'dark'], [KEY, 'light']]);
  f.stored('dark');
  f.flush();
  assert.equal(f.root.dataset.resolvedColorScheme, 'dark');
  assert.equal(f.host().getAttribute('aria-checked'), 'true');
  assert.equal(f.values.get(KEY), 'dark');
  assert.equal(f.writes.length, 2);
  f.scene.destroy(); f.colors.destroy();
  assert.equal(f.host(), null);
  assert.equal(f.intervals.size, 0);
});

test('减弱动效下仍立即切换配色，关闭颜色过渡与云层定时动画', () => {
  const f = fixture({ reduced: true });
  f.host().dispatchEvent(new Event('click'));
  assert.equal(f.root.dataset.resolvedColorScheme, 'dark');
  assert.equal(f.host().getAttribute('aria-checked'), 'true');
  assert.equal(f.root.className, '');
  const cloud = f.shadow().querySelector('.cloud-son');
  assert.equal(f.intervals.size, 0, '减弱动效时不保留无用定时器');
  for (const fn of f.intervals.values()) fn();
  assert.equal(cloud.style.transform, '');
  f.motion.matches = false;
  f.motion.dispatchEvent(new Event('change'));
  assert.equal(f.intervals.size, 1);
  for (const fn of f.intervals.values()) fn();
  assert.match(cloud.style.transform, /translate/);
  f.motion.matches = true;
  f.motion.dispatchEvent(new Event('change'));
  assert.equal(f.intervals.size, 0);
  assert.equal(cloud.style.transform, '');
  f.scene.destroy(); f.colors.destroy();
});

test('挂载前销毁不会在正文加载后创建失去管理的开关', () => {
  const f = fixture({ loading: true });
  f.scene.destroy();
  f.doc.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(f.host(), null);
  assert.equal(f.intervals.size, 0);
  f.colors.destroy();
});
