// 检索端 Range VFS + Worker 端到端回归测试：
//   1. 起真实本地 node:http Range 服务器，在 DB 超过 whole_download_max_bytes 时按需取块并查台词；
//   2. 坏块校验失败自动切备用源；
//   3. 探测阶段与查询阶段遇到 range-ignored 时，按 whole_download_max_bytes 自动降级或明确拒绝；
//   4. mountSearch 在 Worker 启动、取消销毁与不可用回退场景下的行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ChunkFetchError, buildGalleryDb, computeChunkManifest, sha256Hex } from '@gallery/core';
import { loadGallery } from '../../../scripts/lib/data.mjs';
import { loadGalleryDb } from '../src/load.js';
import { createSearchWorkerSession } from '../src/worker.js';
import { mountSearch } from '../src/mount.js';

const FIXTURES = fileURLToPath(new URL('../../core/test/fixtures/data', import.meta.url));
const gallery = await loadGallery({ dataDir: FIXTURES });
const DB_BYTES = await buildGalleryDb(gallery, { pageSize: 4096 });
const CHUNK_SIZE = 4096;
const CHUNKS_MANIFEST = await computeChunkManifest(DB_BYTES, CHUNK_SIZE);
const DB_META = {
  version: '2026-11-21',
  key: 'db/gallery-2026-11-21.sqlite',
  size: DB_BYTES.byteLength,
  sha256: CHUNKS_MANIFEST.sha256,
  pageSize: 4096,
  chunkSize: CHUNK_SIZE,
  chunksSha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(CHUNKS_MANIFEST))),
  chunks: 'db/gallery-2026-11-21.sqlite.chunks.json',
};

function probeResponse(init) {
  if (init?.headers?.Range) {
    return new Response(DB_BYTES.subarray(0, 1), { status: 206, headers: { 'Content-Range': `bytes 0-0/${DB_BYTES.length}` } });
  }
  return new Response(null, { headers: { 'Content-Length': String(DB_BYTES.length), 'Accept-Ranges': 'bytes' } });
}

/** 模拟同线程测试里的同步 HTTP Range 传输（从给定字节视图返回精确切片）。 */
function memoryRangeSync(sourceBuffers, { onRequest } = {}) {
  return (url, start, end) => {
    onRequest?.(url, start, end);
    const parsed = new URL(url);
    const buf = sourceBuffers[parsed.host];
    if (!buf) throw new Error(`未知测试源 ${parsed.host}`);
    if (typeof buf === 'function') return buf(start, end);
    return new Uint8Array(buf.subarray(start, end + 1));
  };
}

/** 用真实 localhost node:http 服务器运行同步 GET Range，验证真实 HTTP 206 传输。 */
function execHttpRangeSync(url, start, end) {
  const script = `
    import http from 'node:http';
    const [url, range] = process.argv.slice(1);
    const req = http.get(url, { agent: false, headers: { Range: range } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        process.stdout.write(JSON.stringify({
          status: res.statusCode,
          cr: res.headers['content-range'] ?? null,
          body: Buffer.concat(parts).toString('base64'),
        }), () => process.exit(0));
      });
    });
    req.on('error', (e) => { console.error(e); process.exit(1); });
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, url, `bytes=${start}-${end}`], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, 206);
  assert.equal(parsed.cr, `bytes ${start}-${end}/${DB_BYTES.byteLength}`);
  return new Uint8Array(Buffer.from(parsed.body, 'base64'));
}

test('Range VFS：在真实 HTTP Range 服务器下突破 whole_download_max_bytes 上限按块查询', async (t) => {
  // HTTP 测试服务跑在独立的 worker_threads 事件循环中，避免 execFileSync 阻塞当前测试线程导致本地回环死锁
  const serverWorker = new NodeWorker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const http = require('node:http');
      const { dbBytes, chunksManifest, chunksKey, dbKey } = workerData;
      const bytes = Buffer.from(dbBytes);
      const requests = [];
      const server = http.createServer((req, res) => {
        requests.push({ method: req.method, url: req.url, range: req.headers.range ?? null });
        if (req.url === '/' + chunksKey) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(chunksManifest));
          return;
        }
        if (req.url === '/' + dbKey) {
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' });
            res.end();
            return;
          }
          const m = /^bytes=(\\d+)-(\\d+)$/.exec(req.headers.range ?? '');
          if (m) {
            const start = Number(m[1]);
            const end = Math.min(Number(m[2]), bytes.length - 1);
            res.writeHead(206, {
              'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length,
              'Content-Length': end - start + 1,
              'Accept-Ranges': 'bytes',
            });
            res.end(bytes.subarray(start, end + 1));
            return;
          }
          res.writeHead(200, { 'Content-Length': bytes.length });
          res.end(bytes);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        parentPort.postMessage({ type: 'ready', port: server.address().port });
      });
      parentPort.on('message', (msg) => {
        if (msg === 'requests') parentPort.postMessage({ type: 'requests', requests });
        if (msg === 'close') server.close(() => parentPort.postMessage({ type: 'closed' }));
      });
    `,
    {
      eval: true,
      workerData: {
        dbBytes: DB_BYTES,
        chunksManifest: CHUNKS_MANIFEST,
        chunksKey: DB_META.chunks,
        dbKey: DB_META.key,
      },
    },
  );
  t.after(() => serverWorker.terminate());

  const port = await new Promise((resolve, reject) => {
    serverWorker.once('error', reject);
    serverWorker.on('message', (msg) => {
      if (msg.type === 'ready') resolve(msg.port);
    });
  });
  const origin = `http://127.0.0.1:${port}`;

  // 故意把 whole_download_max_bytes 设成远小于 DB_BYTES.byteLength（~70 KiB）：
  // 只有 Range VFS 生效时才不被整库上限拦截，且首次查询无需下载完整文件。
  const session = createSearchWorkerSession({
    fetchImpl: (...args) => fetch(...args),
    readRangeSync: execHttpRangeSync,
  });
  try {
    const reply = await session.handleMessage({
      id: 1,
      type: 'query',
      config: {
        images: { hosts: [origin] },
        db: { prefix: 'db/', page_size: 4096, chunk_size: CHUNK_SIZE, whole_download_max_bytes: 16384, release: DB_META },
      },
      query: '漫画作者',
      offset: 0,
    });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.result.modeUsed, 'range');
    assert.equal(reply.result.rows.length, 1);
    assert.equal(reply.result.rows[0].url, '/sample/vol01/c001/#p1b1');

    const requests = await new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg.type === 'requests') {
          serverWorker.off('message', onMsg);
          resolve(msg.requests);
        }
      };
      serverWorker.on('message', onMsg);
      serverWorker.postMessage('requests');
    });
    const rangeGets = requests.filter((r) => r.method === 'GET' && r.url === `/${DB_META.key}`);
    assert.ok(rangeGets.length < Math.ceil(DB_BYTES.byteLength / CHUNK_SIZE), `按需取块应少于全库块数，实际 ${rangeGets.length}`);
    assert.ok(!requests.some((r) => r.method === 'GET' && r.url === `/${DB_META.key}` && !r.range), '不应触发整库 GET');
  } finally {
    await session.handleMessage({ id: 2, type: 'close' });
  }
});

test('Range VFS：坏块 SHA-256 拒绝后自动切到备用 CDN，且保留整份上限保护', async () => {
  const corruptBytes = new Uint8Array(DB_BYTES);
  // 翻转多页内容，确保命中业务块（非第 0 页头）与第 0 块之外的数据块都被污染
  for (let i = 4096; i < corruptBytes.length; i += 4096) corruptBytes[i] ^= 0xff;

  const session = createSearchWorkerSession({
    fetchImpl: async (url, init) => {
      if (url.endsWith('.chunks.json')) return Response.json(CHUNKS_MANIFEST);
      if (url.endsWith('.sqlite')) {
        return probeResponse(init);
      }
      return new Response(null, { status: 404 });
    },
    readRangeSync: memoryRangeSync({
      'bad.example': corruptBytes,
      'good.example': DB_BYTES,
    }),
  });

  try {
    const reply = await session.handleMessage({
      id: 1,
      type: 'query',
      config: {
        images: { hosts: ['bad.example', 'good.example'] },
        db: { prefix: 'db/', whole_download_max_bytes: 8192, release: DB_META },
      },
      query: '契约',
      offset: 0,
    });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.result.modeUsed, 'range');
    assert.equal(reply.result.rows.length, 1);
    assert.equal(reply.result.rows[0].text, '漫画作者的契約');
  } finally {
    session.close();
  }
});

test('Range VFS 降级：全源无视 Range 时按 whole_download_max_bytes 决定自动退回整库或拒绝', async () => {
  const noRangeFetch = async (url) => {
    if (url.endsWith('.chunks.json')) return Response.json(CHUNKS_MANIFEST);
    return new Response(DB_BYTES, { status: 200, headers: { 'Content-Length': String(DB_BYTES.byteLength) } });
  };

  // 预算充足：probe 判定 needsWhole → 自动下载整库并查出结果
  const loaded = await loadGalleryDb({
    config: {
      images: { hosts: ['cdn.example'] },
      db: { prefix: 'db/', whole_download_max_bytes: DB_BYTES.byteLength, release: DB_META },
    },
    fetchImpl: noRangeFetch,
    readRangeSync: () => new Uint8Array(0),
  });
  try {
    assert.equal(loaded.mode, 'whole');
  } finally {
    loaded.db.close();
  }

  // 全源无视 Range 且库体积超过整份上限：明确拒绝，不能绕过预算拉整库
  await assert.rejects(
    loadGalleryDb({
      config: {
        images: { hosts: ['cdn.example'] },
        db: { prefix: 'db/', whole_download_max_bytes: 4096, release: DB_META },
      },
      fetchImpl: noRangeFetch,
      readRangeSync: () => new Uint8Array(0),
    }),
    /超过整份下载上限/,
  );

  // HEAD 撒谎说支持 Range、真正查表读块时才退回 200：Worker 自动关闭 VFS 库并透明退回整库完成查询
  let probeHeadCalls = 0;
  const session = createSearchWorkerSession({
    fetchImpl: async (url, init) => {
      if (url.endsWith('.chunks.json')) return Response.json(CHUNKS_MANIFEST);
      if (init?.headers?.Range) return probeResponse(init);
      if (init?.method === 'HEAD') {
        probeHeadCalls += 1;
        return probeResponse(init);
      }
      return new Response(DB_BYTES, { status: 200, headers: { 'Content-Length': String(DB_BYTES.byteLength) } });
    },
    readRangeSync(_url, start) {
      // 前 4096 字节（第 0 块，建表头/open 探测）放行，后面页才暴露服务端无视 Range
      if (start === 0) return DB_BYTES.subarray(0, CHUNK_SIZE);
      throw new ChunkFetchError('range-ignored', '无视 Range');
    },
  });
  try {
    const reply = await session.handleMessage({
      id: 9,
      type: 'query',
      config: {
        images: { hosts: ['liar.example'] },
        db: { prefix: 'db/', whole_download_max_bytes: DB_BYTES.byteLength, release: DB_META },
      },
      query: '漫画作者',
      offset: 0,
    });
    assert.equal(probeHeadCalls >= 1, true);
    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.result.modeUsed, 'whole');
    assert.equal(reply.result.rows.length, 1);
  } finally {
    session.close();
  }
});

test('mountSearch：支持 Worker 懒加载、分页与销毁，短词/空覆盖率不创建 Worker', async () => {
  class Element {
    children = [];
    listeners = new Map();
    textContent = '';
    value = '';
    hidden = false;
    disabled = false;
    get firstChild() { return this.children[0] ?? null; }
    append(...items) { this.children.push(...items); }
    removeChild(item) { this.children.splice(this.children.indexOf(item), 1); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
  }
  const elements = new Map(['config', 'form', 'input', 'status', 'results', 'more', 'series', 'coverage'].map((name) => [`search-${name}`, new Element()]));
  elements.get('search-config').textContent = JSON.stringify({
    images: { hosts: ['cdn.example'] },
    db: { prefix: 'db/', whole_download_max_bytes: 8192, release: DB_META },
    coverage: { chapters: 4, withText: 2, boxes: 5 },
  });

  const session = createSearchWorkerSession({
    fetchImpl: async (url, init) => {
      if (url.endsWith('.chunks.json')) return Response.json(CHUNKS_MANIFEST);
      return probeResponse(init);
    },
    readRangeSync: memoryRangeSync({ 'cdn.example': DB_BYTES }),
  });

  let spawned = 0;
  let terminated = false;
  const search = mountSearch({
    document: { getElementById: (id) => elements.get(id), createElement: () => new Element() },
    location: { href: 'https://gallery.example/search/', search: '' },
    workerFactory() {
      spawned += 1;
      const listeners = new Map();
      return {
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(fn);
        },
        postMessage(msg) {
          queueMicrotask(async () => {
            const data = await session.handleMessage(msg);
            if (terminated || msg.type === 'close') return;
            for (const fn of listeners.get('message') ?? []) fn({ data });
          });
        },
        terminate() {
          terminated = true;
          session.close();
        },
      };
    },
  });

  // 不足 2 字不创建 Worker
  await search.run('魔');
  assert.equal(spawned, 0);

  const rows = await search.run('漫画作者');
  assert.equal(spawned, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, '/sample/vol01/c001/#p1b1');
  assert.match(elements.get('search-status').textContent, /找到 1 条台词/);

  search.destroy();
  assert.equal(terminated, true);
});

test('只接受页面固定的分块清单；旧发布仍走受限的整库路径', async () => {
  const options = {
    config: { images: { hosts: ['cdn.example'] }, db: { prefix: 'db/', release: DB_META, whole_download_max_bytes: 0 } },
    readRangeSync() { assert.fail('清单未校验时不应打开 VFS'); },
  };
  let calls = 0;
  const invalidManifest = { ...CHUNKS_MANIFEST, chunks: CHUNKS_MANIFEST.chunks.toReversed() };
  await assert.rejects(loadGalleryDb({ ...options, fetchImpl: async () => {
    calls++;
    return Response.json(invalidManifest);
  } }), /分块清单 SHA-256/);
  assert.equal(calls, 1);

  const { chunksSha256: _old, ...legacy } = DB_META;
  options.config.db.release = legacy;
  const getWhole = async (url) => {
    assert.equal(url, `https://cdn.example/${legacy.key}`);
    return new Response(DB_BYTES);
  };
  await assert.rejects(loadGalleryDb({ ...options, fetchImpl: getWhole }), /超过整份下载上限/);
  options.config.db.whole_download_max_bytes = DB_BYTES.length;
  const loaded = await loadGalleryDb({ ...options, fetchImpl: getWhole });
  try { assert.equal(loaded.mode, 'whole'); }
  finally { loaded.db.close(); }
});

test('并发查询共用一次降级，失败后可重新加载', async () => {
  let failWhole = true;
  let wholeRequests = 0;
  const config = { images: { hosts: ['cdn.example'] }, db: { prefix: 'db/', release: DB_META } };
  const session = createSearchWorkerSession({
    fetchImpl: async (url, init) => {
      if (url.endsWith('.json')) return Response.json(CHUNKS_MANIFEST);
      if (init?.method === 'HEAD' || init?.headers?.Range) return probeResponse(init);
      wholeRequests++;
      return failWhole ? new Response(null, { status: 503 }) : new Response(DB_BYTES);
    },
    readRangeSync(_url, start, end) {
      if (start === 0) return DB_BYTES.subarray(start, end + 1);
      throw new ChunkFetchError('range-ignored', '源已停止分块');
    },
  });
  try {
    const query = (id) => session.handleMessage({ type: 'query', id, config, query: '漫画作者' });
    assert.equal((await query(1)).ok, false);
    failWhole = false;
    const replies = await Promise.all([query(2), query(3)]);
    assert.ok(replies.every((r) => r.ok && r.result.modeUsed === 'whole' && r.result.rows.length === 1));
    assert.equal(wholeRequests, 2);
  } finally { session.close(); }
});
