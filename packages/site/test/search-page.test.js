import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/pages/search/index.astro', import.meta.url), 'utf8');
const script = /<script is:inline>\s*([\s\S]*?)<\/script>/.exec(source)[1];
const settle = () => new Promise((resolve) => setImmediate(resolve));

function metadataSearch(items, fetchImpl = async () => ({ ok: true, json: async () => items })) {
  const node = () => {
    let text = '';
    return {
      value: '', children: [], writes: [], listeners: new Map(),
      get textContent() { return text; },
      set textContent(value) { text = value; this.children = []; this.writes.push(value); },
      appendChild(child) { this.children.push(child); },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
    };
  };
  const nodes = new Map(['form', 'q', 'results', 'status'].map((name) => [`meta-${name}`, node()]));
  let requests = 0;
  const renderedTitles = [];
  nodes.get('meta-results').appendChild = function (child) {
    this.children.push(child);
    renderedTitles.push(child.children[0].textContent);
  };
  runInNewContext(script, {
    document: { getElementById: (id) => nodes.get(id), createElement: node },
    fetch: async (...args) => { requests++; return fetchImpl(...args); },
  });
  return {
    nodes, renderedTitles, get requests() { return requests; },
    get titles() { return nodes.get('meta-results').children.map((row) => row.children[0].textContent); },
    input(value) { nodes.get('meta-q').value = value; nodes.get('meta-q').listeners.get('input')(); },
    submit() {
      let prevented = false;
      nodes.get('meta-form').listeners.get('submit')({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true, '键盘或按钮提交不刷新页面');
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const catalog = [
  { title: '晴天故事', url: '/sunny/', chapters: 4 },
  { title: '雨天故事', url: '/rainy/', chapters: 2 },
];
const failureMessage = '作品目录加载失败，请点击“过滤”重试。';

test('作品过滤：空目录明确提示尚无作品，已有目录未匹配则提示没有匹配', async () => {
  const empty = metadataSearch([]);
  await settle();
  assert.equal(empty.nodes.get('meta-status').textContent, '当前还没有作品，内容发布后即可检索。');
  empty.input('示例');
  await settle();
  assert.equal(empty.nodes.get('meta-status').textContent, '当前还没有作品，内容发布后即可检索。');
  assert.equal(empty.requests, 1);

  const populated = metadataSearch([{ title: '示例作品', url: '/sample/', chapters: 4 }]);
  await settle();
  assert.equal(populated.nodes.get('meta-status').textContent, '');
  populated.input('不存在');
  await settle();
  assert.equal(populated.nodes.get('meta-status').textContent, '没有匹配的作品');
  populated.input('示例');
  await settle();
  assert.equal(populated.nodes.get('meta-status').textContent, '');
  assert.equal(populated.requests, 1);
});

for (const [name, firstResponse] of [
  ['HTTP 503', async () => ({ ok: false, status: 503, json: async () => [] })],
  ['网络异常', async () => { throw new Error('暂时断网'); }],
  ['坏 JSON', async () => ({ ok: true, json: async () => JSON.parse('{broken') })],
  ['JSON 错误对象', async () => ({ ok: true, json: async () => ({ error: 'unavailable' }) })],
  ['JSON null', async () => ({ ok: true, json: async () => null })],
]) {
  test(`作品过滤：${name} 显示失败，提交可重试且成功后复用目录`, async () => {
    let attempt = 0;
    const page = metadataSearch(null, async () => {
      if (++attempt === 1) return firstResponse();
      return { ok: true, json: async () => catalog };
    });
    await settle();
    assert.equal(page.nodes.get('meta-status').textContent, failureMessage);
    assert.deepEqual(page.titles, []);
    assert.equal(page.requests, 1);

    page.nodes.get('meta-q').value = '雨天';
    page.submit();
    await settle();
    assert.equal(page.requests, 2);
    assert.deepEqual(page.titles, ['雨天故事']);
    assert.equal(page.nodes.get('meta-status').textContent, '');

    page.input('晴天');
    await settle();
    assert.equal(page.requests, 2, '成功目录在本页缓存');
    assert.deepEqual(page.titles, ['晴天故事']);
  });
}

test('作品过滤：加载中输入与提交共用请求，只渲染最新输入', async () => {
  const pending = deferred();
  const page = metadataSearch(null, () => pending.promise);
  page.input('晴天');
  page.input('雨天');
  page.submit();
  assert.equal(page.requests, 1, '初次加载未完成时不重复取目录');
  pending.resolve({ ok: true, json: async () => catalog });
  await settle();
  assert.deepEqual(page.titles, ['雨天故事']);
  assert.deepEqual(page.renderedTitles, ['雨天故事'], '初始全目录和旧输入都不渲染');
  assert.equal(page.nodes.get('meta-status').textContent, '');

  page.input('晴天');
  page.input('不存在');
  await settle();
  assert.deepEqual(page.titles, []);
  assert.deepEqual(page.renderedTitles, ['雨天故事'], '已缓存目录也忽略过期过滤任务');
  assert.equal(page.nodes.get('meta-status').textContent, '没有匹配的作品');
  assert.equal(page.requests, 1);
});

test('作品过滤：并发失败只更新最新状态，再次输入发起一次重试并接受空目录', async () => {
  const first = deferred();
  const retry = deferred();
  let attempt = 0;
  const page = metadataSearch(null, () => ++attempt === 1 ? first.promise : retry.promise);
  page.input('晴天');
  page.input('雨天');
  first.reject(new Error('断网'));
  await settle();
  assert.equal(page.requests, 1);
  assert.equal(page.nodes.get('meta-status').writes.filter((value) => value === failureMessage).length, 1, '过期请求不重复显示错误');

  page.input('晴天');
  page.input('雨天');
  page.submit();
  assert.equal(page.requests, 2, '重试期间仍共用一个请求');
  retry.resolve({ ok: true, json: async () => [] });
  await settle();
  assert.deepEqual(page.titles, []);
  assert.equal(page.nodes.get('meta-status').textContent, '当前还没有作品，内容发布后即可检索。');
  page.submit();
  await settle();
  assert.equal(page.requests, 2, '真正的空目录也缓存，不反复下载');
});
