import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountReaderImages } from '../src/lib/reader-images.js';

function node(extra = {}) {
  const listeners = new Map();
  return {
    hidden: true, textContent: '', ...extra,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    fire(type) {
      const event = { prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      listeners.get(type)?.(event);
      return event;
    },
  };
}

function fixture({ hosts = ['one.example.org', 'two.example.org'], complete = false, loaded = false, source } = {}) {
  const pages = Array.from({ length: 2 }, (_, i) => {
    const requests = [];
    // 浏览器的 src getter 返回 URL 规范化后的绝对地址，不能用保留大写的原始属性值代替。
    const resolve = (value) => new URL(value, 'https://site.example.org/').href;
    let src = resolve(source?.(i + 1) ?? `https://${hosts[0]}/img/sample/v/c/${i + 1}-abcdef012345.webp`);
    const img = node({ complete, naturalWidth: loaded ? 1200 : 0, loading: 'lazy' });
    Object.defineProperty(img, 'src', { get: () => src, set(value) { src = resolve(value); requests.push(src); } });
    const feedback = node(), message = node(), retry = node();
    const nodes = { '.frame img': img, '.image-feedback': feedback, '.image-message': message, '.image-retry': retry };
    return { dataset: { n: String(i + 1) }, querySelector: (selector) => nodes[selector], img, feedback, message, retry, requests };
  });
  const reader = { querySelectorAll: () => pages };
  const controller = mountReaderImages(reader, { hosts });
  return { pages, controller };
}

test('图片：保持原生 lazy 与原始地址，成功后显示页码且不请求备用源', () => {
  const { pages } = fixture();
  for (const p of pages) {
    assert.equal(p.img.loading, 'lazy');
    assert.deepEqual(p.requests, []);
    assert.equal(p.dataset.imageState, 'loading');
    assert.equal(p.feedback.hidden, false);
    assert.equal(p.retry.hidden, true);
    p.img.naturalWidth = 1200;
    p.img.fire('load');
    assert.equal(p.dataset.imageState, 'loaded');
    assert.equal(p.feedback.hidden, false);
    assert.match(p.message.textContent, /已加载/);
    p.img.fire('error');
    assert.deepEqual(p.requests, []);
  }
});

test('图片：按顺序尝试不同来源，全部失败后停止，只重试被点击的一页', () => {
  const { pages: [p, other] } = fixture({ hosts: ['one.example.org', 'two.example.org', 'two.example.org', 'three.example.org'] });
  p.img.fire('error');
  p.img.fire('error');
  assert.deepEqual(p.requests, [
    'https://two.example.org/img/sample/v/c/1-abcdef012345.webp',
    'https://three.example.org/img/sample/v/c/1-abcdef012345.webp',
  ]);
  p.img.fire('error');
  p.img.fire('error');
  assert.equal(p.requests.length, 2, '耗尽来源后不循环重试');
  assert.equal(p.dataset.imageState, 'failed');
  assert.equal(p.retry.hidden, false);
  assert.match(p.message.textContent, /第 1 页图片加载失败/);
  const event = p.retry.fire('click');
  assert.equal(event.prevented && event.stopped, true, '点击重试不触发阅读器翻页');
  assert.equal(p.dataset.imageState, 'loading');
  assert.equal(p.retry.hidden, true);
  assert.equal(p.img.loading, 'eager');
  assert.equal(p.requests.at(-1), 'https://one.example.org/img/sample/v/c/1-abcdef012345.webp');
  p.img.naturalWidth = 1200;
  p.img.fire('load');
  assert.match(p.message.textContent, /已加载/);
  assert.deepEqual(other.requests, []);
  assert.equal(other.img.loading, 'lazy');
});

test('图片：模块接管前已经成功或失败的图片仍能正确恢复状态', () => {
  const success = fixture({ complete: true, loaded: true }).pages[0];
  assert.match(success.message.textContent, /已加载/);
  assert.deepEqual(success.requests, []);
  const failed = fixture({ complete: true }).pages[0];
  assert.equal(failed.requests.length, 1);
  assert.equal(failed.img.src, 'https://two.example.org/img/sample/v/c/1-abcdef012345.webp');
  const single = fixture({ hosts: ['one.example.org'], complete: true }).pages[0];
  assert.equal(single.dataset.imageState, 'failed');
  assert.equal(single.retry.hidden, false);
  single.retry.fire('click');
  assert.equal(single.requests.length, 1);
});

test('图片：备用源加载成功后不再显示错误，销毁后不继续处理事件', () => {
  const { pages: [p], controller } = fixture();
  p.img.fire('error');
  p.img.naturalWidth = 1200;
  p.img.fire('load');
  assert.equal(p.dataset.imageState, 'loaded');
  assert.match(p.message.textContent, /已加载/);
  controller.destroy();
  p.img.fire('error');
  p.retry.fire('click');
  assert.equal(p.requests.length, 1);
});

test('图片：配置域名大小写按浏览器 URL 规则比较并去重，路径与查询保持不变', () => {
  const suffix = '/img/one.example.org/%E4%B9%A6%E9%A1%B5.webp?x=ONE.EXAMPLE.ORG#p1';
  const { pages: [p, other] } = fixture({
    hosts: ['ONE.EXAMPLE.ORG', 'one.example.org', 'TwO.ExAmPlE.OrG', 'TWO.EXAMPLE.ORG'],
    source: () => `https://ONE.EXAMPLE.ORG${suffix}`,
  });
  assert.equal(p.img.src, `https://one.example.org${suffix}`, '真实 src getter 会把配置首源转成小写');
  p.img.fire('error');
  assert.deepEqual(p.requests, [`https://two.example.org${suffix}`]);
  p.img.fire('error');
  p.img.fire('error');
  assert.equal(p.dataset.imageState, 'failed');
  assert.equal(p.requests.length, 1, '仅大小写不同的来源不能重复请求');
  p.retry.fire('click');
  assert.equal(p.img.src, `https://one.example.org${suffix}`, '单页重试仍从原首源开始');
  p.img.fire('error');
  p.img.fire('error');
  assert.deepEqual(p.requests, [
    `https://two.example.org${suffix}`, `https://one.example.org${suffix}`, `https://two.example.org${suffix}`,
  ]);
  assert.equal(p.dataset.imageState, 'failed');
  assert.deepEqual(other.requests, []);
});

test('图片：当前来源优先，其余规范化来源仍按配置顺序尝试', () => {
  const suffix = '/img/sample/v/c/1-abcdef012345.webp';
  const { pages: [p] } = fixture({
    hosts: ['ONE.EXAMPLE.ORG', 'TWO.EXAMPLE.ORG', 'THREE.EXAMPLE.ORG'],
    source: () => `https://TWO.EXAMPLE.ORG${suffix}`,
  });
  assert.equal(p.img.src, `https://two.example.org${suffix}`);
  p.img.fire('error');
  p.img.fire('error');
  p.img.fire('error');
  assert.deepEqual(p.requests, [`https://one.example.org${suffix}`, `https://three.example.org${suffix}`]);
  assert.equal(p.dataset.imageState, 'failed');
});

for (const [name, source] of [
  ['不在配置中的来源', () => 'https://unknown.example.org/img/sample.webp'],
  ['非 HTTPS 来源', () => 'http://ONE.EXAMPLE.ORG/img/sample.webp'],
]) {
  test(`图片：${name}不切换到配置中的域名`, () => {
    const { pages: [p] } = fixture({ hosts: ['ONE.EXAMPLE.ORG', 'TWO.EXAMPLE.ORG'], source });
    const original = p.img.src;
    p.img.fire('error');
    p.img.fire('error');
    assert.equal(p.dataset.imageState, 'failed');
    assert.deepEqual(p.requests, []);
    p.retry.fire('click');
    assert.deepEqual(p.requests, [original], '手动重试只复用原始地址');
  });
}
