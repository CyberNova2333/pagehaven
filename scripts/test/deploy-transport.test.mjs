import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createStagingVerifier } from '../lib/deploy-ready.mjs';

async function localServer(t, listener) {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return server;
}

test('ESA 测试连接使用真实 HTTP：替换 DNS 后仍保留原 Host、路径与响应正文', { timeout: 10000 }, async (t) => {
  const seen = [];
  const server = await localServer(t, (request, response) => {
    seen.push({ host: request.headers.host, path: request.url });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ version: 'transport-fixture' }));
  });
  const host = `staging.unit-fixture.invalid:${server.address().port}`;
  const verifier = createStagingVerifier('127.0.0.1');
  try {
    // 保留默认 fetch 和默认 Agent，捕获 Node 内置 fetch 与 Undici 包接口不兼容的回归。
    const response = await verifier.fetchImpl(`http://${host}/release.json`, {
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: 'transport-fixture' });
    assert.deepEqual(seen, [{ host, path: '/release.json' }]);
  } finally {
    await verifier.close();
  }
});

test('ESA 测试连接仍遵循调用方中止信号，不会因自定义连接器无限等待', { timeout: 10000 }, async (t) => {
  const server = await localServer(t, () => {});
  const arrived = once(server, 'request', { signal: AbortSignal.timeout(5000) });
  const controller = new AbortController();
  const verifier = createStagingVerifier('127.0.0.1');
  try {
    const request = verifier.fetchImpl(`http://staging.unit-fixture.invalid:${server.address().port}/release.json`, {
      signal: controller.signal,
    });
    const rejected = assert.rejects(request, { name: 'AbortError' });
    await arrived;
    controller.abort();
    await rejected;
  } finally {
    controller.abort();
    await verifier.close();
  }
});
