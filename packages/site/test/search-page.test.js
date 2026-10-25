import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/pages/search/index.astro', import.meta.url), 'utf8');
const script = /<script is:inline>\s*([\s\S]*?)<\/script>/.exec(source)[1];
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function metadataSearch(items) {
  const node = () => ({
    textContent: '', value: '', children: [], listeners: new Map(),
    appendChild(child) { this.children.push(child); },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
  });
  const nodes = new Map(['form', 'q', 'results', 'status'].map((name) => [`meta-${name}`, node()]));
  let requests = 0;
  runInNewContext(script, {
    document: { getElementById: (id) => nodes.get(id), createElement: node },
    fetch: async () => { requests++; return { ok: true, json: async () => items }; },
  });
  return {
    nodes, get requests() { return requests; },
    input(value) { nodes.get('meta-q').value = value; nodes.get('meta-q').listeners.get('input')(); },
  };
}

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
