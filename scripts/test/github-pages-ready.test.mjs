import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForGithubPagesBuild } from '../lib/github-pages-ready.mjs';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const SITE = { build_type: 'legacy', source: { branch: 'gh-pages', path: '/' } };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

function harness(responses) {
  let time = 0;
  const calls = [];
  const progress = [];
  const sleeps = [];
  return {
    calls, progress, sleeps,
    args: {
      repo: 'unit-owner/unit-site', token: 'unit-token', commit: SHA,
      timeoutMs: 50, intervalMs: 10, requestTimeoutMs: 20,
      now: () => time,
      sleepImpl: async (ms) => { sleeps.push(ms); time += ms; },
      onProgress: (message) => progress.push(message),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        const response = responses.shift();
        if (response instanceof Error) throw response;
        assert.ok(response, '测试必须提供每次请求的响应');
        return response;
      },
    },
  };
}

test('Pages 就绪：核对仓库来源，等待本次 SHA 从 queued 到 built，旧提交成功不算', async () => {
  const h = harness([json(SITE), json({ commit: OLD, status: 'built' }), json({ commit: SHA, status: 'queued' }), json({ commit: SHA, status: 'built' })]);
  assert.deepEqual(await waitForGithubPagesBuild(h.args), { commit: SHA, status: 'built' });
  assert.deepEqual(h.sleeps, [10, 10]);
  assert.equal(h.calls[0].url, 'https://api.github.com/repos/unit-owner/unit-site/pages');
  assert.ok(h.calls.slice(1).every((r) => r.url.endsWith('/pages/builds/latest')));
  for (const { options } of h.calls) {
    assert.equal(options.headers.authorization, 'Bearer unit-token');
    assert.equal(options.headers['x-github-api-version'], '2026-03-10');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('Pages 就绪：本次构建失败立即拒绝，错误不回显远端明文', async () => {
  const h = harness([json(SITE), json({ commit: SHA, status: 'errored', error: { message: 'sensitive-server-detail' } })]);
  await assert.rejects(waitForGithubPagesBuild(h.args), (error) => {
    assert.match(error.message, /构建失败/);
    assert.doesNotMatch(error.message, /sensitive-server-detail/);
    return true;
  });
  assert.equal(h.sleeps.length, 0);
});

test('Pages 就绪：发布来源不匹配不能误认其他构建', async () => {
  for (const site of [{ ...SITE, build_type: 'workflow' }, { source: { branch: 'main', path: '/' } }, { source: { branch: 'gh-pages', path: '/docs' } }, {}]) {
    const h = harness([json(site)]);
    await assert.rejects(waitForGithubPagesBuild(h.args), /发布源必须/);
    assert.equal(h.calls.length, 1);
  }
});

test('Pages 就绪：不存在构建、临时服务错误与网络异常可重试，授权错误立即拒绝', async () => {
  const h = harness([new TypeError('offline'), json(SITE), json({}, 404), json({}, 503), json({ commit: SHA, status: 'built' })]);
  assert.equal((await waitForGithubPagesBuild(h.args)).status, 'built');
  assert.equal(h.sleeps.length, 3);
  for (const status of [401, 403, 404]) {
    const denied = harness([json({}, status)]);
    await assert.rejects(waitForGithubPagesBuild(denied.args), new RegExp(`HTTP ${status}`));
    assert.equal(denied.sleeps.length, 0);
  }
});

test('Pages 就绪：限流与一直不是本次提交都受总预算约束', async () => {
  const h = harness([json(SITE), ...Array.from({ length: 5 }, () => json({ commit: OLD, status: 'built' }))]);
  await assert.rejects(waitForGithubPagesBuild(h.args), /超时/);
  assert.equal(h.sleeps.reduce((a, b) => a + b, 0), 50);
  assert.equal(h.progress.filter((s) => /其他提交/.test(s)).length, 1, '状态不变时不刷日志');
  const limited = harness([json({}, 403, { 'x-ratelimit-remaining': '0' }), json(SITE), json({ commit: SHA, status: 'built' })]);
  assert.equal((await waitForGithubPagesBuild(limited.args)).status, 'built');
});

test('Pages 就绪：无效仓库、SHA、凭据或时间预算在联网前拒绝', async () => {
  for (const override of [{ repo: 'owner/../else' }, { repo: 'https://github.com/owner/repo' }, { commit: 'short' }, { token: '' }, { timeoutMs: 0 }, { intervalMs: Infinity }]) {
    const h = harness([]);
    await assert.rejects(waitForGithubPagesBuild({ ...h.args, ...override }));
    assert.equal(h.calls.length, 0);
  }
});
