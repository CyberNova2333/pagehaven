// TC3-HMAC-SHA256 签名的单测 + purge 脚本的端到端。
//
// 签名用固定输入比对固定向量：向量不是拿本实现自己算出来再抄回去的（那只能证明它今天和昨天一样），
// 而是用官方 SDK 的签名实现对同一组输入算出的结果——两份独立实现得到同一个签名，才算对。
// 两个时间戳只差一秒但跨了 UTC 日期，顺带钉住「凭证范围的日期按 UTC 取」。
//
// purge 脚本对着本地假接口跑真 fetch：服务端拿收到的时间戳与正文按同一算法复算签名，验的是
// 「签的正是发出去的那份正文」；接口回错误码要退 1；没凭据退 0；PURGE_DRY_RUN 一个请求都不发。
// 错误路径逐条钉死不许静默成功：非 2xx（网关 / 代理）、JSON 没有 Response（端点指错）、没有 JobId、
// 目标进了 FailedList——每一种都退 1 且日志里没有「已提交」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signTc3, utcDate, TC3_CONTENT_TYPE, TC3_SIGNED_HEADERS } from '../lib/tc3-sign.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'purge.mjs');

const VECTOR_INPUT = {
  secretId: 'AKIDEXAMPLE',
  secretKey: 'EXAMPLEKEY',
  service: 'teo',
  host: 'teo.tencentcloudapi.com',
  action: 'CreatePurgeTask',
  version: '2022-09-01',
  payload: '{"ZoneId":"zone-example","Type":"purge_url","Targets":["https://img.example.org/db/manifest.json"]}',
};
// 2026-09-02T23:59:59Z 与 2026-09-03T00:00:00Z：由官方 SDK 的签名实现对同一输入算出
const VECTORS = [
  [1788393599, 'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2026-09-02/teo/tc3_request, SignedHeaders=content-type;host, Signature=70348e0afb1fccd6b7cb6153144bebd260b75614515bf1246459e99b59a64ab8'],
  [1788393600, 'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2026-09-03/teo/tc3_request, SignedHeaders=content-type;host, Signature=f50e1ff3c83189eb6c2633b762cf0c05cf7fc8a2abde073cb0481f93c538d4f3'],
];
const AUTH_RE = /^TC3-HMAC-SHA256 Credential=([^/]+)\/(\d{4}-\d{2}-\d{2})\/teo\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/;

test('signTc3：固定输入得到固定向量（与官方 SDK 实现一致），日期按 UTC 取', async () => {
  for (const [timestamp, authorization] of VECTORS) {
    const { headers } = signTc3({ ...VECTOR_INPUT, timestamp });
    assert.equal(headers.Authorization, authorization, `timestamp=${timestamp}`);
    assert.equal(headers['X-TC-Timestamp'], String(timestamp));
  }
  assert.equal(utcDate(1788393599), '2026-09-02');
  assert.equal(utcDate(1788393600), '2026-09-03');
});

test('signTc3：确定性与头的形状；region 可选；改动正文或密钥签名就变', async () => {
  const a = signTc3({ ...VECTOR_INPUT, timestamp: 1788393600 });
  const b = signTc3({ ...VECTOR_INPUT, timestamp: 1788393600 });
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a.headers), ['Content-Type', 'Host', 'X-TC-Action', 'X-TC-Version', 'X-TC-Timestamp', 'Authorization']);
  assert.equal(a.headers['Content-Type'], TC3_CONTENT_TYPE);
  assert.equal(a.headers.Host, 'teo.tencentcloudapi.com');
  assert.equal(a.headers['X-TC-Action'], 'CreatePurgeTask');
  assert.equal(a.headers['X-TC-Version'], '2022-09-01');
  assert.match(a.headers.Authorization, AUTH_RE);
  assert.equal(TC3_SIGNED_HEADERS, 'content-type;host');

  const withRegion = signTc3({ ...VECTOR_INPUT, timestamp: 1788393600, region: 'ap-guangzhou' });
  assert.equal(withRegion.headers['X-TC-Region'], 'ap-guangzhou');
  assert.equal(withRegion.headers.Authorization, a.headers.Authorization, 'region 不参与签名');

  const sig = (h) => h.Authorization.split('Signature=')[1];
  assert.notEqual(sig(signTc3({ ...VECTOR_INPUT, timestamp: 1788393600, payload: VECTOR_INPUT.payload + ' ' }).headers), sig(a.headers), '正文多一个空格');
  assert.notEqual(sig(signTc3({ ...VECTOR_INPUT, timestamp: 1788393600, secretKey: 'OTHER' }).headers), sig(a.headers), '换密钥');
  assert.notEqual(sig(signTc3({ ...VECTOR_INPUT, timestamp: 1788393600, host: 'other.example' }).headers), sig(a.headers), '换 host');
  assert.notEqual(sig(signTc3({ ...VECTOR_INPUT, timestamp: 1788393601 }).headers), sig(a.headers), '换时间戳');
});

test('signTc3：缺参数一次列全并抛出', async () => {
  assert.throws(() => signTc3({ ...VECTOR_INPUT, timestamp: 1788393600, secretKey: '' }), /secretKey/);
  assert.throws(() => signTc3({ ...VECTOR_INPUT, timestamp: 1.5 }), /timestamp/);
  assert.throws(() => signTc3({ ...VECTOR_INPUT, timestamp: 1788393600, payload: { not: 'a string' } }), /payload/);
  assert.throws(
    () => signTc3({ timestamp: 1788393600, payload: '{}' }),
    (e) => /secretId, secretKey, service, host, action, version/.test(e.message),
  );
});

// ── purge 脚本 ─────────────────────────────────────────────────────

/** 干净的环境：去掉本机 / CI 里可能存在的凭据与开关，行为只由测试给的决定。 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(EDGEONE_|ESA_|PURGE_|R2_|RELEASE_)/.test(k)) delete env[k];
  return env;
}

/**
 * 异步 spawn 而不是 spawnSync：假接口就住在这个测试进程里，spawnSync 会把事件循环卡住，
 * 服务器答不了话、子进程等回应——死锁。
 */
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...cleanEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

const CREDS = { EDGEONE_SECRET_ID: 'AKIDTEST', EDGEONE_SECRET_KEY: 'test-secret-key', EDGEONE_ZONE_ID: 'zone-test' };

/**
 * 本地假云 API：记录请求，按 responses 依次回话。条目默认是 HTTP 200 + 该 JSON（云 API 的业务错误
 * 也是 200 + Response.Error）；要模拟网关 / 代理 / 指错的端点，用 { httpStatus, httpBody }。
 */
async function fakeApi(responses) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const entry = responses.shift() ?? { Response: { Error: { Code: 'Test.NoMoreResponses', Message: 'no more' }, RequestId: 'none' } };
      const status = entry.httpStatus ?? 200;
      const payload = entry.httpBody ?? entry;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return { requests, host, env: { EDGEONE_API_ENDPOINT: `http://${host}/` }, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('purge：没凭据 → 提示并退出 0；默认目标是 manifest.json 的 CDN 地址；ESA 只留未实现提示', async () => {
  const r = await run([], {});
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /缺 EDGEONE_SECRET_ID \/ EDGEONE_SECRET_KEY \/ EDGEONE_ZONE_ID/);
  assert.match(r.out, /https:\/\/img\.example\.org\/db\/manifest\.json/);
  assert.match(r.out, /ESA.*未实现.*ESA_\*/);
  // 缺一个也算缺
  const r2 = await run([], { EDGEONE_SECRET_ID: 'x', EDGEONE_SECRET_KEY: 'y' });
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /缺 EDGEONE_ZONE_ID/);
});

test('purge：不认识的选项 / 不是 URL 的目标 → 退出 2', async () => {
  assert.equal((await run(['--bogus'], CREDS)).status, 2);
  const r = await run(['ftp://x'], CREDS);
  assert.equal(r.status, 2);
  assert.match(r.out, /完整 URL/);
});

test('purge：真发请求——头与签名对得上正文；接口报错退 1；dry-run 不发；--prefix 换 Type', { timeout: 20_000 }, async (t) => {
  const api = await fakeApi([
    { Response: { JobId: 'job-1', FailedList: [], RequestId: 'req-1' } },
    { Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'bad signature' }, RequestId: 'req-2' } },
    { Response: { JobId: 'job-3', RequestId: 'req-3' } },
  ]);
  t.after(api.close);

  await t.test('成功：CreatePurgeTask / 2022-09-01 / 正文与签名', async () => {
    const r = await run([], { ...CREDS, ...api.env });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /JobId job-1/);
    assert.equal(api.requests.length, 1);
    const req = api.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/');
    assert.equal(req.headers['content-type'], TC3_CONTENT_TYPE);
    assert.equal(req.headers['x-tc-action'], 'CreatePurgeTask');
    assert.equal(req.headers['x-tc-version'], '2022-09-01');
    assert.equal(req.headers['x-tc-region'], undefined);
    assert.equal(req.headers.host, api.host);
    assert.deepEqual(JSON.parse(req.body), { ZoneId: 'zone-test', Type: 'purge_url', Targets: ['https://img.example.org/db/manifest.json'] });
    const m = req.headers.authorization.match(AUTH_RE);
    assert.ok(m, req.headers.authorization);
    assert.equal(m[1], 'AKIDTEST');
    const timestamp = Number(req.headers['x-tc-timestamp']);
    assert.ok(Math.abs(timestamp - Date.now() / 1000) < 60, '时间戳是现在');
    assert.equal(m[2], utcDate(timestamp));
    // 服务端视角：用同一密钥、收到的时间戳与正文复算，必须得到同一个签名
    const expected = signTc3({
      secretId: 'AKIDTEST',
      secretKey: 'test-secret-key',
      service: 'teo',
      host: api.host,
      action: 'CreatePurgeTask',
      version: '2022-09-01',
      payload: req.body,
      timestamp,
    });
    assert.equal(req.headers.authorization, expected.headers.Authorization);
    assert.doesNotMatch(r.out, /zone-test|test-secret-key|Signature=/, '日志里不出现 ZoneId、密钥与签名');
  });

  await t.test('接口回 Error → 退 1 并带错误码', async () => {
    const r = await run([], { ...CREDS, ...api.env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /AuthFailure\.SignatureFailure/);
    assert.match(r.out, /req-2/);
  });

  await t.test('--prefix 与多目标 → purge_prefix；EDGEONE_API_REGION 进 X-TC-Region', async () => {
    const r = await run(['--prefix', 'https://img.example.org/db/', 'https://img.example.org/img/sample/'], { ...CREDS, ...api.env, EDGEONE_API_REGION: 'ap-shanghai' });
    assert.equal(r.status, 0, r.out);
    const req = api.requests[2];
    assert.deepEqual(JSON.parse(req.body), { ZoneId: 'zone-test', Type: 'purge_prefix', Targets: ['https://img.example.org/db/', 'https://img.example.org/img/sample/'] });
    assert.equal(req.headers['x-tc-region'], 'ap-shanghai');
  });

  await t.test('PURGE_DRY_RUN=1：一个请求都不发', async () => {
    const before = api.requests.length;
    const r = await run([], { ...CREDS, ...api.env, PURGE_DRY_RUN: '1' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PURGE_DRY_RUN=1/);
    assert.equal(api.requests.length, before);
  });
});

test('purge：EDGEONE_API_ENDPOINT 带路径 → 退 1、一个请求都不发（签名按根路径算，带路径只会得到签名错误）', async (t) => {
  const api = await fakeApi([]);
  t.after(api.close);
  const r = await run([], { ...CREDS, EDGEONE_API_ENDPOINT: `http://${api.host}/v3/` });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /EDGEONE_API_ENDPOINT 只能是协议 \+ 主机名/);
  assert.equal(api.requests.length, 0);
  assert.doesNotMatch(r.out, /\n\s+at /, '预期中的配置错误不打栈');
  const query = await run([], { ...CREDS, EDGEONE_API_ENDPOINT: `http://${api.host}/?x=1` });
  assert.equal(query.status, 1, query.out);
  assert.equal(api.requests.length, 0);
});

test('purge：错误路径不许静默成功——非 2xx、没有 Response、没有 JobId、目标进 FailedList 都退 1', { timeout: 20_000 }, async (t) => {
  const api = await fakeApi([
    { httpStatus: 403, httpBody: { message: 'forbidden by gateway' } },
    {},
    { Response: { RequestId: 'req-nojob' } },
    { Response: { JobId: 'job-rejected', RequestId: 'req-rej', FailedList: [{ Reason: 'InvalidParameter.Target', Targets: ['https://img.example.org/db/manifest.json'] }] } },
    { Response: { JobId: 'job-partial', RequestId: 'req-partial', FailedList: ['https://img.example.org/img/b/'] } },
  ]);
  t.after(api.close);
  const SUBMITTED = /已提交：JobId/;
  const STACK = /\n\s+at /;

  await t.test('HTTP 403（网关 / 代理挡住、或端点指错）', async () => {
    const r = await run([], { ...CREDS, ...api.env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /接口回 HTTP 403/);
    assert.match(r.out, /forbidden by gateway/);
    assert.doesNotMatch(r.out, SUBMITTED);
    assert.doesNotMatch(r.out, STACK);
  });

  await t.test('HTTP 200 但 JSON 没有 Response 字段', async () => {
    const r = await run([], { ...CREDS, ...api.env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /没有 Response 字段/);
    assert.doesNotMatch(r.out, SUBMITTED);
    assert.doesNotMatch(r.out, STACK);
  });

  await t.test('Response 里既无 Error 也无 JobId', async () => {
    const r = await run([], { ...CREDS, ...api.env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /没有 JobId/);
    assert.match(r.out, /req-nojob/);
    assert.doesNotMatch(r.out, SUBMITTED);
  });

  await t.test('唯一目标进了 FailedList（文档形状 { Reason, Targets }）→ 退 1，列出目标与原因', async () => {
    const r = await run([], { ...CREDS, ...api.env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /任务 job-rejected 已提交，但 1\/1 个目标未被接受（RequestId req-rej）/);
    assert.match(r.out, /https:\/\/img\.example\.org\/db\/manifest\.json：InvalidParameter\.Target/);
    assert.match(r.out, /目标被拒就是没清成/);
    assert.doesNotMatch(r.out, SUBMITTED);
    assert.doesNotMatch(r.out, /✔/);
    assert.doesNotMatch(r.out, STACK);
  });

  await t.test('两个目标一个被拒（字符串形状）→ 也退 1，报 1/2', async () => {
    const r = await run(['--prefix', 'https://img.example.org/img/a/', 'https://img.example.org/img/b/'], { ...CREDS, ...api.env });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /1\/2 个目标未被接受/);
    assert.match(r.out, / {2}https:\/\/img\.example\.org\/img\/b\/\n/);
    assert.doesNotMatch(r.out, SUBMITTED);
  });

  assert.equal(api.requests.length, 5, '每个场景都真的发了请求');
});
