import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorageRefresh } from '../src/lib/storage-refresh.js';

function clock() {
  const pending = new Map();
  const callbacks = [];
  let nextId = 0;
  let now = 0;
  const win = {
    setTimeout(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, due: now + delay });
      callbacks.push(callback);
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
  };
  return {
    win, callbacks,
    get now() { return now; },
    get pending() { return pending.size; },
    get deadlines() { return [...pending.values()].map((task) => task.due).sort((a, b) => a - b); },
    advance(duration) {
      const target = now + duration;
      while (true) {
        const next = [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > target) break;
        const [id, task] = next;
        now = task.due;
        pending.delete(id);
        task.callback();
      }
      now = target;
    },
  };
}

test('千次更新只排一次刷新，临近截止的新事件不延长固定窗口', () => {
  const c = clock();
  const calls = [];
  const refresh = createStorageRefresh(c.win, () => calls.push(c.now));
  for (let i = 0; i < 1000; i++) refresh.request();
  assert.deepEqual(calls, []);
  assert.equal(c.pending, 1);
  assert.deepEqual(c.deadlines, [50]);
  c.advance(49);
  refresh.request();
  assert.deepEqual(c.deadlines, [50]);
  c.advance(1);
  assert.deepEqual(calls, [50]);
  assert.equal(c.pending, 0);
});

test('持续到来的事件仍定期刷新，不等待事件流停止', () => {
  const c = clock();
  const calls = [];
  const refresh = createStorageRefresh(c.win, () => calls.push(c.now));
  refresh.request();
  for (let i = 0; i < 9; i++) {
    c.advance(20);
    refresh.request();
  }
  assert.deepEqual(calls, [50, 110, 170]);
  assert.deepEqual(c.deadlines, [230]);
  c.advance(50);
  assert.deepEqual(calls, [50, 110, 170, 230]);
});

test('主动刷新前取消排队，重排后迟到的旧回调不执行或破坏新窗口', () => {
  const c = clock();
  const calls = [];
  const refresh = createStorageRefresh(c.win, () => calls.push(c.now));
  refresh.request();
  const oldCallback = c.callbacks[0];
  c.advance(20);
  refresh.cancel();
  assert.equal(c.pending, 0);
  refresh.request();
  assert.deepEqual(c.deadlines, [70]);
  oldCallback();
  assert.deepEqual(calls, []);
  refresh.request();
  assert.equal(c.pending, 1, '旧回调不能清掉新窗口的 pending 标记');
  c.advance(49);
  assert.deepEqual(calls, []);
  c.advance(1);
  assert.deepEqual(calls, [70]);
});

test('销毁幂等并清除排队，销毁后的请求和迟到回调均无动作', () => {
  const c = clock();
  let calls = 0;
  const refresh = createStorageRefresh(c.win, () => { calls++; });
  refresh.request();
  const oldCallback = c.callbacks[0];
  refresh.destroy();
  refresh.destroy();
  refresh.request();
  oldCallback();
  c.advance(1000);
  assert.equal(calls, 0);
  assert.equal(c.pending, 0);
  assert.equal(c.callbacks.length, 1);

  const idle = createStorageRefresh(c.win, () => { calls++; });
  idle.destroy();
  idle.request();
  assert.equal(c.pending, 0);
});

test('执行回调前释放窗口，回调内的新请求能合并到下一窗口', () => {
  const c = clock();
  const calls = [];
  const refresh = createStorageRefresh(c.win, () => {
    calls.push(c.now);
    if (calls.length === 1) {
      refresh.request();
      refresh.request();
    }
  });
  refresh.request();
  c.advance(50);
  assert.deepEqual(calls, [50]);
  assert.equal(c.pending, 1);
  c.advance(50);
  assert.deepEqual(calls, [50, 100]);
  assert.equal(c.pending, 0);
});

test('刷新抛错不吞异常，也不让后续请求卡在旧窗口', () => {
  const c = clock();
  let calls = 0;
  const failure = new Error('render failed');
  const refresh = createStorageRefresh(c.win, () => {
    if (++calls === 1) throw failure;
  });
  refresh.request();
  assert.throws(() => c.advance(50), (error) => error === failure);
  assert.equal(c.pending, 0);
  refresh.request();
  c.advance(50);
  assert.equal(calls, 2);
  assert.equal(c.pending, 0);
});

test('等待时间必须在原生计时器范围内，零等待仍异步且支持取消', () => {
  const c = clock();
  for (const delayMs of [-1, NaN, Infinity, '50', null, 2147483648]) {
    assert.throws(() => createStorageRefresh(c.win, () => {}, { delayMs }), TypeError);
  }
  assert.throws(() => createStorageRefresh(c.win, null), TypeError);
  let calls = 0;
  const refresh = createStorageRefresh(c.win, () => { calls++; }, { delayMs: 0 });
  refresh.request();
  assert.equal(calls, 0);
  c.advance(0);
  assert.equal(calls, 1);
  refresh.request();
  refresh.cancel();
  c.advance(0);
  assert.equal(calls, 1);
});
