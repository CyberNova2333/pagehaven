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

function fixture({ hosts = ['one.example.org', 'two.example.org'], complete = false, loaded = false } = {}) {
  const pages = Array.from({ length: 2 }, (_, i) => {
    const requests = [];
    let src = `https://${hosts[0]}/img/sample/v/c/${i + 1}-abcdef012345.webp`;
    const img = node({ complete, naturalWidth: loaded ? 1200 : 0, loading: 'lazy' });
    Object.defineProperty(img, 'src', { get: () => src, set(value) { src = value; requests.push(value); } });
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
