// 执行页面真实的内联脚本，模拟 DOM 事件、视口与存储；不复制翻页/进度算法。
// CSS 排版由浏览器验收，下面专门守住多页交互，避免单页内容掩盖回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/pages/[series]/[issue]/[chapter]/index.astro', import.meta.url), 'utf8');
const script = /<script is:inline>\s*([\s\S]*?)<\/script>/.exec(source)?.[1];
assert.ok(script, '阅读器内联脚本必须存在');

function readerFixture({
  mode = 'single', dir = 'ltr', saved = 1, savedUrl, hash = '', total = 6,
  pageHeight = 1000, pageGap = 0, readerTop = 100, viewportHeight = 800,
  documentHeight, readyState = 'complete',
} = {}) {
  const nodes = new Map();
  const frames = new Map();
  const writes = [];
  const scrolls = [];
  let frameId = 0;
  let scrollPending = false;
  let window;

  function element(id, tagName = 'DIV') {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      id, tagName, dataset: {}, value: '', hidden: false,
      style: { setProperty(name, value) { this[name] = value; } },
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle(name, force = !classes.has(name)) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      },
      addEventListener(type, listener, options = {}) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ listener, once: options.once });
      },
      removeEventListener(type, listener) {
        listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry.listener !== listener));
      },
      fire(type, props = {}) {
        const event = { target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
        for (const { listener, once } of [...(listeners.get(type) ?? [])]) {
          if (once) el.removeEventListener(type, listener);
          listener(event);
        }
        return event;
      },
      closest(selector) { return selector === `#${id}` ? el : null; },
      querySelector() { return null; },
      getBoundingClientRect() { return { top: 0, left: 0, width: 1000, height: 1000 }; },
      scrollIntoView() { scrolls.push(id); },
      focus() { this.focused = true; },
    };
    if (id) nodes.set(id, el);
    return el;
  }

  const reader = element('reader');
  reader.dataset = { key: 'sample/v/c', url: '/sample/v/c/', title: '测试章节', series: '测试作品', issue: '第一卷' };
  reader.parentNode = { insertBefore(el) { nodes.set(el.id, el); } };
  const pages = Array.from({ length: total }, (_,i) => {
    const page = element(`p${i + 1}`, 'SECTION');
    const img = element('', 'IMG');
    img.loading = 'lazy';
    page.img = img;
    page.querySelector = (selector) => selector === 'img' ? img : null;
    page.getBoundingClientRect = () => ({ top: readerTop + i * (pageHeight + pageGap) - window.scrollY, left: 0, width: 1000, height: pageHeight });
    page.scrollIntoView = () => {
      scrolls.push(page.id);
      scrollTo(readerTop + i * (pageHeight + pageGap) - 64);
    };
    return page;
  });
  reader.querySelectorAll = () => pages;
  for (const id of ['page-input', 'page-prev', 'page-next', 'progress-fill', 'text-toggle', 'toc', 'settings', 'brightness', 'toc-btn', 'toc-close', 'settings-btn', 'fullscreen-btn']) element(id);
  const settings = nodes.get('settings');
  settings.querySelector = () => element('', 'INPUT');
  nodes.get('toc').hidden = true;
  settings.hidden = true;

  const location = { hash };
  const history = { replaceState(_state, _title, url) { location.hash = url; } };
  const data = new Map([
    ['gallery:reader:settings', JSON.stringify({ mode, dir, brightness: 100 })],
    ['gallery:progress:sample/v/c', JSON.stringify({ n: saved, url: savedUrl })],
  ]);
  const localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) { data.set(key, value); writes.push({ key, value }); },
  };
  const document = element('document');
  document.readyState = readyState;
  document.documentElement = { scrollHeight: documentHeight ?? readerTop + total * (pageHeight + pageGap) + 100 };
  document.getElementById = (id) => nodes.get(id) ?? null;
  document.createElement = (tag) => element('', tag.toUpperCase());
  window = element('window');
  window.innerHeight = viewportHeight;
  window.scrollY = 0;
  window.getSelection = () => null;
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  function scrollTo(top) {
    window.scrollY = Math.min(Math.max(0, document.documentElement.scrollHeight - window.innerHeight), Math.max(0, top));
    // 浏览器在脚本结束后才派发滚动事件，且 scrollIntoView 会受当前文档最大滚动位置限制。
    scrollPending = true;
  }
  window.scrollBy = ({ top }) => scrollTo(window.scrollY + top);
  const hit = /^#p(\d+)b(\d+)$/.exec(hash);
  if (hit) {
    const page = pages[Number(hit[1]) - 1];
    const box = element(hash.slice(1), 'SPAN');
    box.getBoundingClientRect = () => ({ top: page.getBoundingClientRect().top + 30, bottom: page.getBoundingClientRect().top + 50 });
    box.scrollIntoView = () => {
      scrolls.push(box.id);
      scrollTo(window.scrollY + box.getBoundingClientRect().top + 10 - window.innerHeight / 2);
    };
  }

  runInNewContext(script, { document, window, location, history, localStorage });

  const flushFrame = () => {
    if (scrollPending) {
      scrollPending = false;
      window.fire('scroll');
    }
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  };
  const flush = () => {
    for (let i = 0; frames.size || scrollPending; i++) {
      assert.ok(i < 20, '动画帧应在有限次内稳定');
      flushFrame();
    }
  };
  const key = (value, target = element('', 'BODY')) => document.fire('keydown', { key: value, target });
  return {
    nodes, pages, reader, window, document, location, writes, scrolls, flush, flushFrame, key,
    current: () => Number(nodes.get('page-input').value),
    progress: () => JSON.parse(data.get('gallery:progress:sample/v/c')),
    visible: () => pages.filter((page) => page.classList.contains('current')).map((page) => page.id),
    click: (id) => nodes.get(id).fire('click'),
    changeMode(value) { settings.fire('change', { target: { name: 'reader-mode', value } }); },
    scrollTo(top) { scrollTo(top); flush(); },
    scrollToPage(n) { scrollTo(readerTop + (n - 1) * (pageHeight + pageGap)); flush(); },
    completeDocument(addedHeight = 0) {
      document.documentElement.scrollHeight += addedHeight;
      document.readyState = 'interactive';
      document.fire('DOMContentLoaded');
      document.readyState = 'complete';
    },
    clickHalf(side) {
      const frame = element('', 'DIV');
      frame.closest = (selector) => selector === '.frame' ? frame : null;
      reader.fire('click', { target: frame, clientX: side === 'left' ? 100 : 900 });
    },
    swipe(dx) {
      reader.fire('touchstart', { touches: [{ clientX: 500 }] });
      reader.fire('touchend', { changedTouches: [{ clientX: 500 + dx }] });
    },
  };
}

test('损坏或遗留的非整数进度回到第一页，不生成空白页或继续保存非法值', () => {
  for (const mode of ['single', 'double', 'long']) {
    for (const saved of [2.5, 'bad', '3', null, {}, [2], Number.MAX_SAFE_INTEGER + 1]) {
      const r = readerFixture({ mode, saved });
      assert.doesNotThrow(() => r.flush());
      assert.equal(r.current(), 1, `${mode}: ${JSON.stringify(saved)}`);
      assert.ok(r.visible().includes('p1'));
      assert.equal(r.progress().n, 1);
      if (mode === 'long') {
        r.scrollToPage(3);
        assert.equal(r.progress().n, 3, '恢复结束后滚动仍能保存进度');
      } else {
        r.click('page-next');
        assert.ok(Number.isSafeInteger(r.progress().n));
      }
    }
  }
});

test('恢复只接受本章地址，保留没有地址字段的旧整数记录及正常越界裁剪', () => {
  for (const [options, expected] of [
    [{ saved: 4 }, 4],
    [{ saved: 4, savedUrl: '/sample/v/c/' }, 4],
    [{ saved: 4, savedUrl: '/other/v/c/' }, 1],
    [{ saved: 99, savedUrl: '/sample/v/c/' }, 6],
    [{ saved: -2 }, 1],
  ]) {
    const r = readerFixture(options);
    assert.equal(r.current(), expected);
    assert.deepEqual(r.visible(), [`p${expected}`]);
  }
});

test('核心翻页入口拒绝非整数与非有限页码，超长 hash 不污染后续导航', () => {
  const r = readerFixture();
  for (const n of [NaN, Infinity, 2.5, '3', null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    r.reader.galleryReader.showPage(n);
    assert.equal(r.current(), 1);
    assert.equal(r.location.hash, '#p1');
    assert.deepEqual(r.visible(), ['p1']);
  }
  const hash = readerFixture({ hash: '#p' + '9'.repeat(400) });
  assert.equal(hash.current(), 1);
  hash.click('page-next');
  assert.equal(hash.current(), 2);
});

for (const dir of ['ltr', 'rtl']) {
  test(`阅读器 ${dir}：下一页/上一页与空格始终按章节顺序`, () => {
    const r = readerFixture({ dir });
    r.click('page-next');
    assert.equal(r.current(), 2);
    assert.equal(r.location.hash, '#p2');
    r.click('page-prev');
    assert.equal(r.current(), 1);
    r.key(' ');
    assert.equal(r.current(), 2);
    assert.equal(r.progress().n, 2);
  });

  test(`阅读器 ${dir}：左右键、点击与滑动只映射一次方向`, () => {
    const advance = dir === 'ltr' ? 'ArrowRight' : 'ArrowLeft';
    const retreat = dir === 'ltr' ? 'ArrowLeft' : 'ArrowRight';
    const r = readerFixture({ dir, saved: 3 });
    r.key(advance);
    assert.equal(r.current(), 4);
    r.key(retreat);
    assert.equal(r.current(), 3);
    r.clickHalf(dir === 'ltr' ? 'right' : 'left');
    assert.equal(r.current(), 4);
    r.clickHalf(dir === 'ltr' ? 'left' : 'right');
    assert.equal(r.current(), 3);
    r.swipe(dir === 'ltr' ? -100 : 100);
    assert.equal(r.current(), 4);
    r.swipe(dir === 'ltr' ? 100 : -100);
    assert.equal(r.current(), 3);
  });

  test(`阅读器 ${dir}：双页按跨页前进，奇数末页与上一跨页正确`, () => {
    const r = readerFixture({ dir, mode: 'double', total: 5 });
    assert.deepEqual(r.visible(), ['p1', 'p2']);
    r.click('page-next');
    assert.deepEqual(r.visible(), ['p3', 'p4']);
    r.click('page-next');
    assert.deepEqual(r.visible(), ['p5']);
    assert.equal(r.nodes.get('page-next').hidden, true);
    r.click('page-prev');
    assert.deepEqual(r.visible(), ['p3', 'p4']);
    assert.equal(r.reader.classList.contains('rtl'), dir === 'rtl');
  });
}

test('阅读器：按钮上的空格保留原生操作，不劫持成翻页', () => {
  const r = readerFixture();
  const event = r.key(' ', { tagName: 'BUTTON' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(r.current(), 1);
});

test('阅读器：目录输入框按 Escape 关闭面板并返回目录按钮，不翻页', () => {
  const r = readerFixture();
  r.click('toc-btn');
  assert.equal(r.nodes.get('toc').hidden, false);
  const event = r.key('Escape', { tagName: 'INPUT' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(r.nodes.get('toc').hidden, true);
  assert.equal(r.nodes.get('toc-btn').focused, true);
  assert.equal(r.current(), 1);
});

test('阅读器：目录或重试控件上的触摸手势不翻页，下一次正常滑动仍可用', () => {
  const r = readerFixture();
  const control = { closest: () => ({ tagName: 'BUTTON' }) };
  r.reader.fire('touchstart', { target: control, touches: [{ clientX: 500 }] });
  r.reader.fire('touchend', { changedTouches: [{ clientX: 350 }] });
  assert.equal(r.current(), 1);
  r.swipe(-100);
  assert.equal(r.current(), 2);
});

test('阅读器：定位到目录链接后，空格与方向键不改漫画页码', () => {
  const r = readerFixture();
  r.click('toc-btn');
  for (const key of [' ', 'ArrowRight', 'ArrowLeft']) {
    const event = r.key(key, { tagName: 'A' });
    assert.equal(event.defaultPrevented, false);
    assert.equal(r.current(), 1);
  }
  r.key('ArrowRight', { tagName: 'DIV', closest: () => r.nodes.get('toc') });
  assert.equal(r.current(), 1);
});

test('阅读器桥接：增强阅读器接管双页导航，偶数页不再归并且不发生二次翻页', () => {
  const r = readerFixture({ mode: 'double', total: 4 });
  const api = r.reader.galleryReader;
  const navigations = [];
  const updates = [];
  const unsubscribe = api.subscribe((state) => updates.push({ ...state }));
  api.setEnhancement({ navigate: (delta) => navigations.push(delta) });
  assert.equal(updates.length, 0, '设置增强句柄不能递归触发订阅');
  api.showPage(4);
  assert.equal(r.current(), 4);
  assert.equal(r.progress().n, 4);
  assert.equal(r.location.hash, '#p4');
  assert.equal(updates.at(-1).page, 4);
  assert.equal(api.getState().mode, 'double');

  api.showPage(3);
  assert.equal(r.nodes.get('page-next').hidden, false, '窄屏原生单页必须仍能进入第4页');
  r.click('page-next');
  r.click('page-prev');
  assert.deepEqual(navigations, [1, -1]);
  assert.equal(r.current(), 3, '由增强阅读器回报页码，旧脚本不能额外推进');
  r.key('ArrowRight');
  const space = r.key(' ');
  r.clickHalf('right');
  r.swipe(-100);
  assert.equal(space.defaultPrevented, false);
  assert.equal(r.current(), 3);
  assert.deepEqual(navigations, [1, -1]);

  r.changeMode('single');
  assert.equal(updates.at(-1).mode, 'single');
  unsubscribe();
  const count = updates.length;
  api.showPage(4);
  assert.equal(updates.length, count);
  api.setEnhancement(null);
  api.refresh();
  assert.equal(r.current(), 4);
  r.click('page-prev');
  assert.equal(r.current(), 3, '卸载增强后恢复原阅读器导航');
});

for (const initial of [{ saved: 4 }, { saved: 1, hash: '#p4' }]) {
  test(`阅读器桥接：双页启动保留${initial.hash ? '深链' : '旧进度'}请求的偶数页供增强接管`, () => {
    const r = readerFixture({ mode: 'double', total: 4, ...initial });
    const api = r.reader.galleryReader;
    assert.equal(api.getState().page, 3);
    assert.equal(api.getState().requestedPage, 4);
    assert.equal(r.progress().n, 3, '旧阅读器仍按既有双页起点保存');
    api.setEnhancement({ navigate() {} });
    api.showPage(api.getState().requestedPage);
    assert.equal(api.getState().page, 4);
    assert.equal(api.getState().requestedPage, 4);
    assert.equal(r.progress().n, 4);
  });
}

test('长条：恢复保存页并滚动定位，全章图片仍保留 lazy', () => {
  const r = readerFixture({ mode: 'long', saved: 4 });
  r.flush();
  assert.equal(r.current(), 4);
  assert.equal(r.progress().n, 4);
  assert.deepEqual(r.scrolls, ['p4']);
  assert.ok(r.pages.every((page) => page.img.loading === 'lazy'));
  r.scrollToPage(6);
  assert.equal(r.current(), 6);
  assert.equal(r.reader.galleryReader.getState().requestedPage, 6);
  assert.equal(r.progress().n, 6);
  assert.equal(r.location.hash, '#p6');
  r.changeMode('single');
  assert.deepEqual(r.visible(), ['p6']);
});

test('长条：短末页等页尾解析后恢复，期间的滚动和离开事件不能覆盖进度', () => {
  const r = readerFixture({
    mode: 'long', saved: 4, total: 4, readyState: 'loading',
    readerTop: 400, pageHeight: 520, pageGap: 20, viewportHeight: 844, documentHeight: 2640,
  });
  assert.equal(r.current(), 4);
  assert.equal(r.progress().n, 4);
  assert.deepEqual(r.scrolls, [], '不能按尚未解析完的文档高度定位');
  // 旧版此时会被 2640 - 844 的滚动上限截住，末页顶部 224px 超过判页标记 200px。
  r.window.scrollY = 2640 - 844;
  assert.equal(r.pages[3].getBoundingClientRect().top, 224);
  r.window.fire('scroll');
  r.window.fire('pagehide');
  r.flush();
  assert.equal(r.writes.length, 0);
  assert.equal(r.progress().n, 4);

  r.completeDocument(220);
  r.flushFrame();
  assert.deepEqual(r.scrolls, ['p4']);
  assert.equal(r.pages[3].getBoundingClientRect().top, 64, '完整文档允许正确定位最后一页');
  r.window.fire('pagehide');
  assert.equal(r.writes.length, 0, '定位触发的滚动处理完前仍处于恢复阶段');
  r.flush();
  r.window.fire('scroll');
  r.flush();
  assert.equal(r.current(), 4);
  assert.equal(r.progress().n, 4);
  assert.equal(r.writes.length, 1);
  assert.notEqual(r.location.hash, '#p3');
});

test('长条：完整文档中末页仍无法置顶时按文末保留末页，用户滚回后正常保存', () => {
  const r = readerFixture({
    mode: 'long', saved: 4, total: 4,
    readerTop: 400, pageHeight: 520, pageGap: 20, viewportHeight: 844, documentHeight: 2640,
  });
  r.flush();
  assert.equal(r.pages[3].getBoundingClientRect().top, 224);
  assert.equal(r.window.scrollY + r.window.innerHeight, r.document.documentElement.scrollHeight);
  r.window.fire('scroll');
  r.flush();
  assert.equal(r.progress().n, 4);
  r.scrollToPage(3);
  assert.equal(r.progress().n, 3);
});

test('长条：解析期间气泡深链优先，完成定位前不把旧进度写成其他页', () => {
  const r = readerFixture({ mode: 'long', saved: 2, hash: '#p4b0', readyState: 'loading' });
  assert.equal(r.current(), 4);
  assert.equal(r.progress().n, 2);
  assert.deepEqual(r.scrolls, []);
  r.window.fire('scroll');
  r.flush();
  assert.equal(r.progress().n, 2);
  r.completeDocument(220);
  r.flush();
  assert.deepEqual(r.scrolls, ['p4', 'p4b0']);
  assert.equal(r.nodes.get('p4b0').classList.contains('hl'), true);
  assert.equal(r.progress().n, 4);
  assert.equal(r.location.hash, '#p4b0');
});

test('长条：解析期间更新深链只恢复最新目标', () => {
  const r = readerFixture({ mode: 'long', saved: 4, readyState: 'loading' });
  r.location.hash = '#p2';
  r.window.fire('hashchange');
  r.completeDocument();
  r.flush();
  assert.deepEqual(r.scrolls, ['p2']);
  assert.equal(r.current(), 2);
  assert.equal(r.progress().n, 2);
});

test('长条：恢复前切换单页会取消待执行定位，单页不等待文档解析', () => {
  const r = readerFixture({ mode: 'long', saved: 4, readyState: 'loading' });
  r.changeMode('single');
  r.click('page-next');
  assert.equal(r.current(), 5);
  assert.equal(r.progress().n, 5);
  r.completeDocument();
  r.flush();
  assert.deepEqual(r.visible(), ['p5']);
  assert.ok(!r.scrolls.includes('p4'));

  const single = readerFixture({ saved: 3, readyState: 'loading' });
  single.click('page-next');
  assert.equal(single.current(), 4);
  assert.equal(single.progress().n, 4);
});

test('长条：深链优先于旧进度，同页滚动保留气泡 hash，仅跨页写存储', () => {
  const r = readerFixture({ mode: 'long', saved: 2, hash: '#p4b0' });
  r.flush();
  assert.deepEqual(r.scrolls, ['p4', 'p4b0']);
  assert.equal(r.current(), 4);
  assert.equal(r.nodes.get('p4b0').classList.contains('hl'), true);
  const writes = r.writes.length;
  r.window.scrollY += 100;
  r.window.fire('scroll');
  r.window.fire('scroll');
  r.flush();
  assert.equal(r.writes.length, writes);
  assert.equal(r.location.hash, '#p4b0');
  r.scrollToPage(5);
  assert.equal(r.writes.length, writes + 1);
  assert.equal(r.location.hash, '#p5');
});

test('长条：离开页面前保存尚未执行下一帧的滚动，文末记最后一页', () => {
  const r = readerFixture({ mode: 'long' });
  r.flush();
  r.window.scrollY = 4100;
  r.window.fire('scroll');
  r.window.fire('pagehide');
  assert.equal(r.progress().n, 5);
  r.window.scrollY = 5400;
  r.window.fire('scroll');
  r.flush();
  assert.equal(r.progress().n, 6);
});

test('长条：判页标记到达页顶才换页，页间空隙归前页，首尾边界正确', () => {
  const r = readerFixture({ mode: 'long', total: 4, readerTop: 500, pageHeight: 1000, pageGap: 100 });
  r.flush();
  const initialWrites = r.writes.length;
  r.scrollTo(0);
  assert.equal(r.current(), 1, '尚未滚到第一张图时仍是第一页');
  assert.equal(r.writes.length, initialWrites);
  // 第1页占文档500..1500，第2页从1600开始；判页标记位于视口顶部200px。
  r.scrollTo(1350);
  assert.equal(r.current(), 1, '标记落在1550px的页间空隙时保留前页');
  r.scrollTo(1399);
  assert.equal(r.current(), 1, '标记距第2页顶部还差1px');
  assert.equal(r.writes.length, initialWrites, '同一页内滚动不重复写存储');
  r.scrollTo(1400);
  assert.equal(r.current(), 2, '页顶恰好达到标记时进入下一页');
  assert.equal(r.progress().n, 2);
  assert.equal(r.location.hash, '#p2');
  assert.equal(r.writes.length, initialWrites + 1);
  r.scrollTo(1399);
  assert.equal(r.current(), 1, '向上跨回边界时恢复前页');
  assert.equal(r.writes.length, initialWrites + 2);
  r.scrollTo(3600);
  assert.equal(r.current(), 4, '末页顶部达到标记时进入末页');
  assert.equal(r.progress().n, 4);
  assert.equal(r.location.hash, '#p4');
});

test('长条：单页章节无需查询页位置，滚动仍保持第一页', () => {
  const r = readerFixture({ mode: 'long', total: 1 });
  r.flush();
  let reads = 0;
  const measure = r.pages[0].getBoundingClientRect;
  r.pages[0].getBoundingClientRect = () => { reads++; return measure(); };
  const writes = r.writes.length;
  r.scrollTo(200);
  r.scrollTo(1000);
  r.scrollTo(0);
  assert.equal(reads, 0);
  assert.equal(r.current(), 1);
  assert.equal(r.progress().n, 1);
  assert.equal(r.writes.length, writes);
});

test('长条：不同页高与布局变化后仍按实时位置判页', () => {
  const r = readerFixture({ mode: 'long', total: 5 });
  r.flush();
  const tops = [100, 450, 2000, 2400, 4000];
  r.pages.forEach((page, i) => {
    page.getBoundingClientRect = () => ({ top: tops[i] - r.window.scrollY });
  });
  r.scrollTo(1800);
  assert.equal(r.current(), 3);
  tops[2] = 2300;
  r.window.fire('resize');
  r.flush();
  assert.equal(r.current(), 2, '前页变高后不沿用陈旧坐标');
  r.scrollTo(2100);
  assert.equal(r.current(), 3);
  r.scrollTo(3800);
  assert.equal(r.current(), 5);
});

test('长条：1000页章节每次判页最多读取10个页位置，同页滚动不写存储', (t) => {
  const r = readerFixture({ mode: 'long', total: 1000 });
  r.flush();
  let reads = 0;
  for (const page of r.pages) {
    const measure = page.getBoundingClientRect;
    page.getBoundingClientRect = () => { reads++; return measure(); };
  }
  r.scrollToPage(900);
  const firstReads = reads;
  assert.equal(r.current(), 900);
  assert.equal(r.progress().n, 900);
  assert.ok(reads > 0 && reads <= 10, `第900页判页读取了${reads}次`);
  const writes = r.writes.length;
  reads = 0;
  r.scrollTo(r.window.scrollY + 10);
  const samePageReads = reads;
  assert.equal(r.current(), 900);
  assert.equal(r.writes.length, writes);
  assert.equal(r.location.hash, '#p900');
  assert.ok(reads > 0 && reads <= 10, `同页滚动读取了${reads}次`);
  for (const n of [1, 500, 999, 1000]) {
    reads = 0;
    r.scrollToPage(n);
    assert.equal(r.current(), n);
    assert.ok(reads <= 10, `第${n}页判页读取了${reads}次`);
  }
  assert.ok(r.pages.every((page) => page.img.loading === 'lazy'));
  t.diagnostic(`1000页夹具：第900页读取${firstReads}次；同页再滚10px读取${samePageReads}次`);
});
