// 取块层的端到端测试：真起本地 http 服务器、真传字节、真算摘要，不 mock 网络。
//
// 每台服务器的行为由一个可随时改的 mode 对象决定：正常 206 / 无视 Range 回 200 / 少给字节 /
// 回错字节 / 接了连接不回数据 / 慢 / 服务 N 次后 500 / 尺寸不一致 / 不支持 HEAD。这个库要防的
// 失败模式（服务端少给字节、镜像版本不一致、连接卡住不回数据）在 mock 里全都不会发生。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as chunkfetch from '../src/chunkfetch/index.js';
import { probe, fetchRange, fetchWhole, SourceSet, pickSource, ChunkedFile, ChunkFetchError } from '../src/chunkfetch/index.js';
// sha256Hex 是取块层的内部实现，不从 index.js 出去（db 模块对外导出同名函数，两边 export * 会撞）
import { sha256Hex } from '../src/chunkfetch/digest.js';

const CHUNK = 1024;
const FILE = randomBytes(CHUNK * 20 + 333); // 21 块，最后一块短
const MANIFEST = manifestOf(FILE, CHUNK);

/** 与 build:db 产出的 chunks.json 同形；这里用 node:crypto 算，与被测的 Web Crypto 实现互相印证。 */
function manifestOf(buf, chunkSize) {
  const chunks = [];
  for (let off = 0; off < buf.length; off += chunkSize) {
    chunks.push(createHash('sha256').update(buf.subarray(off, off + chunkSize)).digest('hex'));
  }
  return { totalBytes: buf.length, chunkSize, sha256: createHash('sha256').update(buf).digest('hex'), chunks };
}

/** 把某几块的字节翻转，得到「CDN 回错字节」的样本 */
function corrupt(buf, chunkIndices, chunkSize = CHUNK) {
  const out = Buffer.from(buf);
  for (const k of chunkIndices) for (let i = k * chunkSize; i < Math.min(out.length, (k + 1) * chunkSize); i++) out[i] ^= 0xff;
  return out;
}

const servers = [];
after(() => Promise.all(servers.map((s) => s.close())));

/**
 * @param {string} name
 * @param {Buffer} body
 * @param {object} [modeInit]
 *   head: false → HEAD 回 405；acceptRanges: false → HEAD 不带 Accept-Ranges；
 *   range: 'ignore' → 无视 Range 回 200；short: true → 206 但只给一半（Content-Length 也是一半）；
 *   cut: true → 206 声称全长、写一半就断开；wrongContentRange: true → Content-Range 偏一位；
 *   hang: 'headers' | 'body' | 'get' → 接了连接不回头 / 回了头不回体 / 只有 GET 不回头；delayMs → 回应前等待；
 *   status → 一律回这个状态码；failNext → 接下来 n 次回 500；trickle: {size, everyMs} → 慢慢写；
 *   headLength → HEAD 的 Content-Length 用这个值（模拟对 HEAD 回 0 的代理）；gzip → 整份 GET 压缩后发
 */
async function startServer(name, body, modeInit = {}) {
  const mode = { head: true, acceptRanges: true, range: 'ok', short: false, cut: false, wrongContentRange: false, hang: false, delayMs: 0, status: null, failNext: 0, trickle: null, headLength: null, gzip: false, body, ...modeInit };
  const requests = [];
  const pending = new Set();
  const counters = { aborted: 0, bytesWritten: 0 };
  const send = (res, buf) => {
    if (!mode.trickle) {
      counters.bytesWritten += buf.length;
      res.end(buf);
      return;
    }
    let off = 0;
    const tick = () => {
      if (res.destroyed || res.writableEnded) return;
      const piece = buf.subarray(off, off + mode.trickle.size);
      off += piece.length;
      counters.bytesWritten += piece.length;
      if (off >= buf.length) res.end(piece);
      else {
        res.write(piece);
        setTimeout(tick, mode.trickle.everyMs);
      }
    };
    tick();
  };
  const server = http.createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    requests.push({ method: req.method, range: req.headers.range ?? null, start: m ? Number(m[1]) : null, end: m ? Number(m[2]) : null });
    res.on('close', () => {
      if (!res.writableFinished) counters.aborted += 1;
      pending.delete(res);
    });
    if (mode.hang === 'headers' || (mode.hang === 'get' && req.method === 'GET')) {
      pending.add(res);
      return;
    }
    const respond = () => {
      const data = mode.body;
      const etag = `"${name}-${data.length}"`;
      if (mode.failNext > 0) {
        mode.failNext -= 1;
        res.writeHead(500);
        res.end('boom');
        return;
      }
      if (mode.status) {
        res.writeHead(mode.status);
        res.end();
        return;
      }
      if (req.method === 'HEAD') {
        if (!mode.head) {
          res.writeHead(405);
          res.end();
          return;
        }
        const h = { 'Content-Length': mode.headLength ?? data.length, ETag: etag };
        if (mode.acceptRanges) h['Accept-Ranges'] = 'bytes';
        res.writeHead(200, h);
        res.end();
        return;
      }
      if (!m || mode.range === 'ignore') {
        if (mode.gzip) {
          // CDN 误开压缩的样子：Content-Length 是压缩后长度，body 是 gzip 流（客户端会自动解压）
          const gz = gzipSync(data);
          res.writeHead(200, { 'Content-Length': gz.length, 'Content-Encoding': 'gzip', ETag: etag });
          res.end(gz);
          return;
        }
        res.writeHead(200, { 'Content-Length': data.length, ETag: etag, 'Accept-Ranges': mode.acceptRanges ? 'bytes' : 'none' });
        if (mode.hang === 'body') {
          pending.add(res);
          return;
        }
        send(res, data);
        return;
      }
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), data.length - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        res.end();
        return;
      }
      let slice = data.subarray(start, end + 1);
      if (mode.short) slice = slice.subarray(0, Math.floor(slice.length / 2));
      const cr = mode.wrongContentRange ? `bytes ${start}-${end + 1}/${data.length}` : `bytes ${start}-${end}/${data.length}`;
      res.writeHead(206, { 'Content-Range': cr, 'Content-Length': mode.cut ? slice.length : slice.length, ETag: etag, 'Accept-Ranges': 'bytes' });
      if (mode.hang === 'body') {
        pending.add(res);
        return;
      }
      if (mode.cut) {
        res.write(slice.subarray(0, Math.floor(slice.length / 2)));
        res.destroy();
        return;
      }
      send(res, slice);
    };
    if (mode.delayMs > 0) setTimeout(respond, mode.delayMs);
    else respond();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/db/gallery.sqlite`;
  const handle = {
    name,
    url,
    mode,
    requests,
    counters,
    /** 对某一块的请求数 */
    hitsFor(index) {
      const start = index * CHUNK;
      return requests.filter((r) => r.method === 'GET' && r.start === start).length;
    },
    get gets() {
      return requests.filter((r) => r.method === 'GET').length;
    },
    async close() {
      for (const res of pending) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  servers.push(handle);
  return handle;
}

const rejectsWithCode = async (promise, code) => {
  let caught = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ChunkFetchError, `应抛 ChunkFetchError，实际 ${caught?.constructor?.name}: ${caught?.message}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
};

const sourcesOf = (...srv) => new SourceSet(srv.map((s) => ({ id: s.name, url: s.url })));
const fileOf = (sources, extra = {}) =>
  new ChunkedFile({ sources, manifest: MANIFEST, timeoutMs: 2000, retry: { baseDelayMs: 5, maxDelayMs: 40 }, ...extra });

// ── 探测 ────────────────────────────────────────────────────────────

test('probe：HEAD 带 Accept-Ranges: bytes 与 Content-Length 就判支持，只发一次请求', async () => {
  const s = await startServer('a', FILE);
  const r = await probe(s.url);
  assert.deepEqual(r, { total: FILE.length, rangeSupported: true, etag: `"a-${FILE.length}"` });
  assert.deepEqual(s.requests.map((q) => q.method), ['HEAD']);
});

test('probe：HEAD 被拒（405）时走 GET bytes=0-0，206 + Content-Range 判支持，总长取自 /total', async () => {
  const s = await startServer('a', FILE, { head: false });
  const r = await probe(s.url);
  assert.equal(r.rangeSupported, true);
  assert.equal(r.total, FILE.length);
  assert.deepEqual(s.requests.map((q) => [q.method, q.range]), [['HEAD', null], ['GET', 'bytes=0-0']]);
});

test('probe：HEAD 没有 Accept-Ranges 也不下结论，靠 GET 探测判支持', async () => {
  const s = await startServer('a', FILE, { acceptRanges: false });
  const r = await probe(s.url);
  assert.equal(r.rangeSupported, true);
  assert.equal(r.total, FILE.length);
  assert.equal(s.requests.length, 2);
});

test('probe：GET 回 200 = 服务端无视 Range → 不支持，总长取 Content-Length，且立刻中止 body 不读整份', async () => {
  const big = randomBytes(400 * 1024);
  const s = await startServer('a', big, { head: false, range: 'ignore', trickle: { size: 8 * 1024, everyMs: 5 } });
  const r = await probe(s.url);
  assert.equal(r.rangeSupported, false);
  assert.equal(r.total, big.length);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(s.counters.bytesWritten < big.length, `服务端只该写出一小部分，实际 ${s.counters.bytesWritten}/${big.length}`);
  assert.equal(s.counters.aborted, 1, '服务端应看到连接被中止');
});

test('probe：HEAD 回 Content-Length: 0（代理对 HEAD 的老毛病）不算数，落到 GET 探测取真正的总长', async () => {
  const s = await startServer('a', FILE, { headLength: 0 });
  const r = await probe(s.url);
  assert.deepEqual(r, { total: FILE.length, rangeSupported: true, etag: `"a-${FILE.length}"` });
  assert.deepEqual(s.requests.map((q) => [q.method, q.range]), [['HEAD', null], ['GET', 'bytes=0-0']]);
  // ChunkedFile 不会因此把一条正常的源当成「0 字节的旧文件」禁掉
  const f = fileOf(sourcesOf(s));
  await f.probeAll();
  assert.equal(f.sources.stats('a').disabled, false);
  assert.equal(f.sources.stats('a').total, FILE.length);
  assert.deepEqual(Buffer.from(await f.readChunk(1)), FILE.subarray(CHUNK, CHUNK * 2));
});

test('probe：HEAD 正常但 GET 探测接了连接不回头 → GET 阶段的固定时限也生效，抛 timeout', async () => {
  const s = await startServer('a', FILE, { acceptRanges: false, hang: 'get' });
  const t0 = Date.now();
  const e = await rejectsWithCode(probe(s.url, { timeoutMs: 100 }), 'timeout');
  assert.ok(Date.now() - t0 < 1500);
  assert.match(e.message, /GET Range 超过 100 ms/);
  assert.deepEqual(s.requests.map((q) => q.method), ['HEAD', 'GET']);
});

test('probe：206 但没有 Content-Range 不算真支持', async () => {
  const s = await startServer('a', FILE, { head: false });
  const fetchNoCR = async (url, init) => {
    const res = await fetch(url, init);
    const headers = new Headers(res.headers);
    headers.delete('content-range');
    return new Response(res.body, { status: res.status, headers });
  };
  const r = await probe(s.url, { fetch: fetchNoCR });
  assert.equal(r.rangeSupported, false);
});

test('probe：连不上 → network；GET 探测拿到 4xx → http-<status>', async () => {
  const gone = await startServer('gone', FILE);
  await gone.close();
  await rejectsWithCode(probe(gone.url), 'network');
  const s = await startServer('a', FILE, { status: 404 });
  await rejectsWithCode(probe(s.url), 'http-404');
});

// ── 取块 ────────────────────────────────────────────────────────────

test('fetchRange：正常 206 拿到恰好那一段；最后一块（短块）也对', async () => {
  const s = await startServer('a', FILE);
  const mid = await fetchRange(s.url, CHUNK * 3, CHUNK * 4 - 1);
  assert.deepEqual(Buffer.from(mid), FILE.subarray(CHUNK * 3, CHUNK * 4));
  const last = await fetchRange(s.url, CHUNK * 20, FILE.length - 1);
  assert.equal(last.length, 333);
  assert.deepEqual(Buffer.from(last), FILE.subarray(CHUNK * 20));
});

test('fetchRange：请求 bytes=a-b 收到 200 → range-ignored，a>0 与 a==0 都拒绝而不是照收', async () => {
  const s = await startServer('a', FILE, { range: 'ignore' });
  const e1 = await rejectsWithCode(fetchRange(s.url, CHUNK, CHUNK * 2 - 1), 'range-ignored');
  assert.match(e1.message, /文件开头塞进中间/);
  const e0 = await rejectsWithCode(fetchRange(s.url, 0, CHUNK - 1), 'range-ignored');
  assert.match(e0.message, /整份下载/);
});

test('fetchRange：少给字节 → short-body，绝不返回半块；写一半断开 → 也是错，不是半块', async () => {
  const s = await startServer('a', FILE, { short: true });
  const e = await rejectsWithCode(fetchRange(s.url, 0, CHUNK - 1), 'short-body');
  assert.equal(e.expected, CHUNK);
  s.mode.short = false;
  s.mode.cut = true;
  let caught = null;
  try {
    await fetchRange(s.url, 0, CHUNK - 1);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ChunkFetchError);
  assert.ok(['short-body', 'network'].includes(caught.code), caught.code);
  assert.ok(caught.received < CHUNK);
});

test('fetchRange：206 但 Content-Range 与请求不符 → content-range-mismatch', async () => {
  const s = await startServer('a', FILE, { wrongContentRange: true });
  await rejectsWithCode(fetchRange(s.url, CHUNK, CHUNK * 2 - 1), 'content-range-mismatch');
});

test('fetchRange：接了连接不回数据（不回头 / 不回体）→ timeout；慢但在动的连接不会被读超时误杀', async () => {
  const s = await startServer('a', FILE, { hang: 'headers' });
  const t0 = Date.now();
  await rejectsWithCode(fetchRange(s.url, 0, CHUNK - 1, { timeoutMs: 150 }), 'timeout');
  assert.ok(Date.now() - t0 < 1500);
  s.mode.hang = 'body';
  const e = await rejectsWithCode(fetchRange(s.url, 0, CHUNK - 1, { timeoutMs: 150 }), 'timeout');
  assert.equal(e.received, 0);
  // 每 40 ms 来 128 字节，整块要 300 多 ms > timeoutMs，但每段间隔远小于 timeoutMs → 应成功
  s.mode.hang = false;
  s.mode.trickle = { size: 128, everyMs: 40 };
  const bytes = await fetchRange(s.url, 0, CHUNK - 1, { timeoutMs: 150 });
  assert.deepEqual(Buffer.from(bytes), FILE.subarray(0, CHUNK));
});

test('fetchRange：5xx → http-<status>；连不上 → network；外部 signal 取消原样抛回', async () => {
  const s = await startServer('a', FILE, { status: 503 });
  await rejectsWithCode(fetchRange(s.url, 0, CHUNK - 1), 'http-503');
  const gone = await startServer('gone', FILE);
  await gone.close();
  await rejectsWithCode(fetchRange(gone.url, 0, CHUNK - 1), 'network');
  const hang = await startServer('h', FILE, { hang: 'headers' });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(fetchRange(hang.url, 0, CHUNK - 1, { signal: ac.signal, timeoutMs: 5000 }), (e) => e.name === 'AbortError');
});

test('fetchWhole：整份 GET 长度必须恰好等于期望；206 或长度不符都拒绝', async () => {
  const s = await startServer('a', FILE);
  const bytes = await fetchWhole(s.url, FILE.length);
  assert.deepEqual(Buffer.from(bytes), FILE);
  await rejectsWithCode(fetchWhole(s.url, FILE.length + 1), 'short-body');
  s.mode.body = FILE.subarray(0, 100);
  await rejectsWithCode(fetchWhole(s.url, FILE.length), 'short-body');
});

test('fetchWhole：CDN 对 db/* 误开压缩 → 仍以 short-body 拒绝，且 message 点名 Content-Encoding 与 §7', async () => {
  const s = await startServer('a', FILE, { gzip: true });
  const e = await rejectsWithCode(fetchWhole(s.url, FILE.length), 'short-body');
  assert.equal(e.contentEncoding, 'gzip');
  assert.match(e.message, /Content-Encoding: gzip/);
  assert.match(e.message, /db\/\* 开了压缩（ARCHITECTURE §7）/);
  assert.notEqual(e.declared, FILE.length);
  // 没有 Content-Encoding 时不提压缩，免得把「旧版本文件」误导成 CDN 配置问题
  const plain = await startServer('b', FILE.subarray(0, 100));
  const e2 = await rejectsWithCode(fetchWhole(plain.url, FILE.length), 'short-body');
  assert.equal(e2.contentEncoding, null);
  assert.doesNotMatch(e2.message, /Content-Encoding/);
});

// ── 选源策略（假 stats 单测）────────────────────────────────────────

const fake = (id, over = {}) => ({
  id, url: `http://${id}/`, weight: 1, ema: 0, samples: 0, failures: 0, inFlight: 0, consecutiveFailures: 0,
  lastFailure: null, disabled: false, disabledReason: null, rangeSupported: null, total: null, etag: null, ...over,
});

test('pickSource：没样本的源至少被试一次；有样本后按 EMA/(1+在途) 挑；weight 是先验', () => {
  // 全没样本：声明顺序
  assert.equal(pickSource([fake('a'), fake('b')]), 'a');
  // a 有成绩，b 没样本 → 与最好的源打平，平局新源优先
  assert.equal(pickSource([fake('a', { ema: 1e6, samples: 3 }), fake('b')]), 'b');
  // b 的先验权重更高 → 更优先；a 权重更高则压过没样本的 b
  assert.equal(pickSource([fake('a', { ema: 1e6, samples: 3 }), fake('b', { weight: 2 })]), 'b');
  assert.equal(pickSource([fake('a', { ema: 1e6, samples: 3, weight: 2 }), fake('b')]), 'a');
  // 都有样本：快的赢
  assert.equal(pickSource([fake('a', { ema: 1e5, samples: 3 }), fake('b', { ema: 5e5, samples: 3 })]), 'b');
  // 快的在途多了就轮到慢的：5e5/(1+4) = 1e5 < 1e5/(1+0)？相等 → 在途少的优先
  assert.equal(pickSource([fake('a', { ema: 1e5, samples: 3 }), fake('b', { ema: 5e5, samples: 3, inFlight: 4 })]), 'a');
  assert.equal(pickSource([fake('a', { ema: 1e5, samples: 3 }), fake('b', { ema: 5e5, samples: 3, inFlight: 2 })]), 'b');
});

test('pickSource：禁用与排除的不选；连败到阈值的源只在没别的源时才用；没候选返回 null', () => {
  assert.equal(pickSource([fake('a', { disabled: true }), fake('b')]), 'b');
  assert.equal(pickSource([fake('a'), fake('b')], { exclude: ['a'] }), 'b');
  assert.equal(pickSource([fake('a', { ema: 9e9, samples: 5, consecutiveFailures: 3 }), fake('b', { ema: 1, samples: 1 })]), 'b');
  assert.equal(pickSource([fake('a', { consecutiveFailures: 3 }), fake('b', { consecutiveFailures: 5 })]), 'a');
  assert.equal(pickSource([fake('a', { rangeSupported: false }), fake('b', { rangeSupported: true })], { filter: (s) => s.rangeSupported !== false }), 'b');
  assert.equal(pickSource([fake('a', { disabled: true })]), null);
  assert.equal(pickSource([], {}), null);
});

test('SourceSet：EMA、在途数、连败数、禁用原因的记账', () => {
  const set = new SourceSet([{ id: 'a', url: 'http://a/' }, { id: 'b', url: 'http://b/', weight: 2 }], { alpha: 0.5 });
  assert.deepEqual(set.ids, ['a', 'b']);
  set.onStart('a');
  assert.equal(set.stats('a').inFlight, 1);
  set.onSuccess('a', 1000, 100); // 10 000 B/s
  assert.equal(set.stats('a').ema, 10000);
  set.onStart('a');
  set.onSuccess('a', 1000, 50); // 20 000 B/s → EMA = 0.5×20000 + 0.5×10000
  assert.equal(set.stats('a').ema, 15000);
  assert.equal(set.stats('a').samples, 2);
  assert.equal(set.stats('a').inFlight, 0);
  set.onStart('b');
  set.onFailure('b', 'timeout');
  set.onStart('b');
  set.onFailure('b', 'http-500');
  assert.equal(set.stats('b').consecutiveFailures, 2);
  assert.equal(set.stats('b').lastFailure, 'http-500');
  set.onStart('b');
  set.onSuccess('b', 1, 1);
  assert.equal(set.stats('b').consecutiveFailures, 0);
  set.onStart('b');
  set.onCancel('b');
  assert.equal(set.stats('b').inFlight, 0);
  assert.equal(set.stats('b').failures, 2);
  set.disable('b', '尺寸不一致');
  assert.equal(set.pick(), 'a');
  set.enable('b');
  assert.equal(set.stats('b').disabledReason, null);
  assert.throws(() => new SourceSet([{ id: 'a', url: 'http://a/' }, { id: 'a', url: 'http://b/' }]), /重复/);
  assert.throws(() => set.stats('zzz'), /未知的源/);
  // stats() 给的是快照，改它不影响账本
  set.stats('a').ema = 0;
  assert.equal(set.stats('a').ema, 15000);
});

// ── 分块文件 ────────────────────────────────────────────────────────

test('sha256Hex 与 node:crypto 一致；它不从 chunkfetch/index.js 出去（与 db 模块的同名导出不撞）', async () => {
  assert.equal(await sha256Hex(new Uint8Array(FILE)), MANIFEST.sha256);
  assert.equal(await sha256Hex(new Uint8Array(0)), createHash('sha256').digest('hex'));
  assert.equal('sha256Hex' in chunkfetch, false);
});

test('ChunkedFile：manifest 形状不对就在构造时拦下', () => {
  const sources = new SourceSet([{ id: 'a', url: 'http://a/' }]);
  assert.throws(() => new ChunkedFile({ sources, manifest: { ...MANIFEST, chunks: MANIFEST.chunks.slice(1) } }), /应有 21 项/);
  assert.throws(() => new ChunkedFile({ sources, manifest: { ...MANIFEST, sha256: 'xyz' } }), /64 位 hex/);
  assert.throws(() => new ChunkedFile({ sources: [], manifest: MANIFEST }), /SourceSet/);
  const f = new ChunkedFile({ sources, manifest: MANIFEST });
  assert.equal(f.chunkCount, 21);
  assert.deepEqual(f.chunkRange(20), { start: CHUNK * 20, end: FILE.length - 1, length: 333 });
  assert.throws(() => f.chunkRange(21), RangeError);
});

test('probeAll：尺寸不一致的源被禁用并记原因；不支持 Range 的源留给整份下载、分块读不找它', async () => {
  const a = await startServer('a', FILE);
  const stale = await startServer('stale', FILE.subarray(0, FILE.length - 500));
  const noRange = await startServer('nr', FILE, { head: false, range: 'ignore' });
  const f = fileOf(sourcesOf(a, stale, noRange));
  const { needsWhole, results } = await f.probeAll();
  assert.equal(needsWhole, false);
  assert.equal(results.stale.total, FILE.length - 500);
  assert.equal(f.sources.stats('stale').disabled, true);
  assert.match(f.sources.stats('stale').disabledReason, /尺寸不一致/);
  assert.equal(f.sources.stats('nr').rangeSupported, false);
  assert.equal(f.sources.stats('nr').disabled, false);
  assert.equal(f.sources.stats('a').rangeSupported, true);
  const all = await f.read(0, FILE.length);
  assert.deepEqual(Buffer.from(all), FILE);
  assert.equal(stale.gets, 0);
  assert.equal(noRange.gets, 1, '不支持 Range 的源只在探测时被 GET 过一次');
});

test('probe：接了连接不回头的源受 timeoutMs 固定时限约束 → timeout；ChunkedFile 探测时把它禁用而不是挂住整页', async () => {
  const hang = await startServer('hang', FILE, { hang: 'headers' });
  const t0 = Date.now();
  await rejectsWithCode(probe(hang.url, { timeoutMs: 100 }), 'timeout');
  assert.ok(Date.now() - t0 < 1500);
  const ok = await startServer('ok', FILE);
  const f = fileOf(sourcesOf(hang, ok), { timeoutMs: 100 });
  const t1 = Date.now();
  const { results } = await f.probeAll();
  assert.ok(Date.now() - t1 < 1500, '探测不能被卡住的源拖住');
  assert.equal(results.hang.error.code, 'timeout');
  assert.match(f.sources.stats('hang').disabledReason, /探测失败：timeout/);
  assert.deepEqual(Buffer.from(await f.readChunk(4)), FILE.subarray(CHUNK * 4, CHUNK * 5));
  assert.equal(hang.gets, 0);
  // 源恢复后再探一次就回来了
  hang.mode.hang = false;
  await f.probeAll();
  assert.equal(f.sources.stats('hang').disabled, false);
});

test('probeAll：探测失败（连不上）的源禁用；一条都不剩 → no-usable-source 点名每条源', async () => {
  const gone = await startServer('gone', FILE);
  await gone.close();
  const stale = await startServer('stale', FILE.subarray(1));
  const f = fileOf(sourcesOf(gone, stale));
  const e = await rejectsWithCode(f.probeAll(), 'no-usable-source');
  assert.match(e.message, /gone：已禁用（探测失败：network）/);
  assert.match(e.message, /stale：已禁用（尺寸不一致/);
  await rejectsWithCode(f.readChunk(0), 'no-usable-source');
});

test('不支持 Range：needsWhole，readChunk 拒绝，downloadWhole 拿到整份且校验通过；整份被篡改的源被换掉', async () => {
  const bad = await startServer('bad', corrupt(FILE, [7]), { head: false, range: 'ignore' });
  const good = await startServer('good', FILE, { head: false, range: 'ignore' });
  const verifyFailed = [];
  const switches = [];
  const progress = [];
  const f = fileOf(sourcesOf(bad, good), {
    onChunkVerifyFailed: (e) => verifyFailed.push(e),
    onSourceSwitch: (e) => switches.push(e),
    onProgress: (e) => progress.push(e),
  });
  assert.equal((await f.probeAll()).needsWhole, true);
  assert.equal(f.needsWhole, true);
  await rejectsWithCode(f.readChunk(0), 'needs-whole');
  const whole = await f.downloadWhole();
  assert.deepEqual(Buffer.from(whole), FILE);
  assert.deepEqual(verifyFailed, [{ chunk: null, source: 'bad' }]);
  assert.deepEqual(switches, [{ from: 'bad', to: 'good', chunk: null, why: 'checksum' }]);
  assert.ok(progress.some((p) => p.kind === 'whole' && p.source === 'good' && p.received === FILE.length && p.total === FILE.length));
  assert.equal(f.sources.stats('bad').lastFailure, 'checksum');
});

test('坏块被校验拦下并报出块号；换源后拿到正确数据；没坏的块照旧从原源取', async () => {
  const a = await startServer('a', corrupt(FILE, [5]));
  const b = await startServer('b', FILE);
  const verifyFailed = [];
  const switches = [];
  const f = fileOf(new SourceSet([{ id: 'a', url: a.url, weight: 10 }, { id: 'b', url: b.url }]), {
    onChunkVerifyFailed: (e) => verifyFailed.push(e),
    onSourceSwitch: (e) => switches.push(e),
  });
  const c0 = await f.readChunk(0);
  assert.deepEqual(Buffer.from(c0), FILE.subarray(0, CHUNK));
  const c5 = await f.readChunk(5);
  assert.deepEqual(Buffer.from(c5), FILE.subarray(CHUNK * 5, CHUNK * 6));
  assert.deepEqual(verifyFailed, [{ chunk: 5, source: 'a' }]);
  assert.deepEqual(switches, [{ from: 'a', to: 'b', chunk: 5, why: 'checksum' }]);
  assert.equal(a.hitsFor(5), 1, '坏块不在同一条源上重试——缓存里的坏块下次还是那份');
  assert.equal(b.hitsFor(5), 1);
});

test('一台挂了（500 / 连接被拒）照样读完整份；全挂时错误点名每条源与失败原因', async () => {
  const down = await startServer('down', FILE, { status: 500 });
  const ok = await startServer('ok', FILE);
  const f = fileOf(sourcesOf(down, ok));
  const all = await f.read(0, FILE.length);
  assert.deepEqual(Buffer.from(all), FILE);
  assert.ok(down.gets >= 1 && down.gets <= 4, `挂掉的源应很快被换掉，实际被请求 ${down.gets} 次`);

  // 探测之后才断开：取块时遇到 network 错也要能换源
  const later = await startServer('later', FILE);
  const ok2 = await startServer('ok2', FILE);
  const f2 = fileOf(sourcesOf(later, ok2));
  await f2.probeAll();
  await later.close();
  assert.deepEqual(Buffer.from(await f2.readChunk(3)), FILE.subarray(CHUNK * 3, CHUNK * 4));

  // 探测时还活着、之后全挂：这才轮得到取块环节的放弃逻辑（探测就挂的源直接被禁用，见 probeAll 测试）
  const d1 = await startServer('d1', FILE);
  const d2 = await startServer('d2', FILE);
  const f3 = fileOf(sourcesOf(d1, d2), { retry: { maxAttempts: 6, baseDelayMs: 1, maxDelayMs: 2 } });
  await f3.probeAll();
  d1.mode.status = 500;
  d2.mode.status = 502;
  const e = await rejectsWithCode(f3.readChunk(2), 'exhausted');
  assert.equal(e.chunk, 2);
  assert.equal(e.attempts, 6);
  assert.deepEqual(e.failures, { d1: ['http-500', 'http-500', 'http-500'], d2: ['http-502', 'http-502', 'http-502'] });
  assert.match(e.message, /d1：http-500 ×3/);
  assert.match(e.message, /d2：http-502 ×3/);
});

test('慢源拿到的块少于快源：每条源至少试一次，之后按实测吞吐挑', async () => {
  const slow = await startServer('slow', FILE, { delayMs: 60 });
  const fast = await startServer('fast', FILE);
  const f = fileOf(sourcesOf(slow, fast), { cacheChunks: 0 });
  for (let i = 0; i < 21; i++) assert.deepEqual(Buffer.from(await f.readChunk(i)), FILE.subarray(i * CHUNK, (i + 1) * CHUNK));
  assert.ok(slow.gets >= 1, '慢源也要被试过');
  assert.ok(slow.gets < fast.gets, `慢源 ${slow.gets} 次应少于快源 ${fast.gets} 次`);
  assert.ok(slow.gets <= 4, `慢源被试 ${slow.gets} 次，EMA 应很快把它淘汰`);
  assert.ok(f.sources.stats('fast').ema > f.sources.stats('slow').ema);
});

test('卡住的源被 timeoutMs 兜住并换源；全卡时由 budgetMs 兜底而不是次数上限', async () => {
  const hang = await startServer('hang', FILE);
  const ok = await startServer('ok', FILE);
  const f = fileOf(new SourceSet([{ id: 'hang', url: hang.url, weight: 10 }, { id: 'ok', url: ok.url }]), { timeoutMs: 120 });
  await f.probeAll();
  hang.mode.hang = 'body';
  const t0 = Date.now();
  assert.deepEqual(Buffer.from(await f.readChunk(1)), FILE.subarray(CHUNK, CHUNK * 2));
  assert.ok(Date.now() - t0 < 2000, `应在几次读超时内换源，实际耗时 ${Date.now() - t0} ms`);
  assert.equal(f.sources.stats('hang').lastFailure, 'timeout');

  const h1 = await startServer('h1', FILE);
  const h2 = await startServer('h2', FILE);
  const g = new ChunkedFile({
    sources: sourcesOf(h1, h2),
    manifest: MANIFEST,
    timeoutMs: 100,
    retry: { maxAttempts: 1000, baseDelayMs: 5, maxDelayMs: 20, budgetMs: 450 },
  });
  await g.probeAll();
  h1.mode.hang = 'headers';
  h2.mode.hang = 'body';
  const t1 = Date.now();
  const e = await rejectsWithCode(g.readChunk(0), 'exhausted');
  const elapsed = Date.now() - t1;
  assert.ok(elapsed < 3000, `预算 450 ms 应在几秒内放弃，实际 ${elapsed} ms`);
  assert.ok(e.attempts < 1000 && e.attempts >= 3, `应由预算而不是次数上限终止，实际 ${e.attempts} 次`);
  assert.ok(e.spentMs >= 300, `失败耗时应累计到预算附近，实际 ${e.spentMs}`);
  assert.ok(e.failures.h1?.every((c) => c === 'timeout'));
  assert.match(e.message, /h1：timeout/);
  assert.match(e.message, /h2：/);
});

test('单源时原地指数退避重试：服务 N 次 500 后恢复，最终拿到数据且不触发换源', async () => {
  const flaky = await startServer('flaky', FILE);
  const switches = [];
  const f = fileOf(sourcesOf(flaky), { onSourceSwitch: (e) => switches.push(e) });
  await f.probeAll();
  flaky.mode.failNext = 4;
  assert.deepEqual(Buffer.from(await f.readChunk(9)), FILE.subarray(CHUNK * 9, CHUNK * 10));
  assert.equal(flaky.hitsFor(9), 5);
  assert.deepEqual(switches, []);
  assert.equal(f.sources.stats('flaky').consecutiveFailures, 0);
});

test('HEAD 说支持、GET 却无视 Range 的源：取块时暴露为 range-ignored，立刻换源且之后不再找它分块', async () => {
  const liar = await startServer('liar', FILE, { range: 'ignore' });
  const honest = await startServer('honest', FILE);
  const switches = [];
  const f = fileOf(new SourceSet([{ id: 'liar', url: liar.url, weight: 10 }, { id: 'honest', url: honest.url }]), {
    onSourceSwitch: (e) => switches.push(e),
  });
  await f.probeAll();
  assert.equal(f.sources.stats('liar').rangeSupported, true, 'HEAD 探测阶段被它骗过');
  assert.deepEqual(Buffer.from(await f.readChunk(2)), FILE.subarray(CHUNK * 2, CHUNK * 3));
  assert.deepEqual(switches, [{ from: 'liar', to: 'honest', chunk: 2, why: 'range-ignored' }]);
  assert.equal(f.sources.stats('liar').rangeSupported, false);
  await f.read(0, FILE.length);
  assert.equal(liar.gets, 1);
});

test('并发读同一块只发一次请求；不同块并行取', async () => {
  const a = await startServer('a', FILE, { delayMs: 20 });
  const f = fileOf(sourcesOf(a));
  await f.probeAll();
  const results = await Promise.all([0, 1, 2, 3, 4].map(() => f.readChunk(3)));
  assert.equal(a.hitsFor(3), 1);
  for (const r of results) assert.deepEqual(Buffer.from(r), FILE.subarray(CHUNK * 3, CHUNK * 4));
  assert.equal(await f.readChunk(3), results[0], '命中缓存返回同一份');
  const t0 = Date.now();
  await f.read(CHUNK * 10, CHUNK * 8);
  assert.ok(Date.now() - t0 < 8 * 20, '8 块应并行而不是串行');
});

test('read 跨块拼接正确，返回的是独立副本', async () => {
  const a = await startServer('a', FILE);
  const f = fileOf(sourcesOf(a));
  const cases = [
    [CHUNK - 10, 30],
    [0, 1],
    [CHUNK * 3 + 5, CHUNK * 2],
    [CHUNK * 20 + 300, 33],
    [0, FILE.length],
  ];
  for (const [off, len] of cases) {
    const got = await f.read(off, len);
    assert.equal(got.length, len);
    assert.deepEqual(Buffer.from(got), FILE.subarray(off, off + len), `read(${off}, ${len})`);
  }
  assert.equal((await f.read(5, 0)).length, 0);
  const copy = await f.read(0, 16);
  copy.fill(0);
  assert.deepEqual(Buffer.from(await f.read(0, 16)), FILE.subarray(0, 16));
  await assert.rejects(f.read(FILE.length - 1, 2), RangeError);
  await assert.rejects(f.read(-1, 2), RangeError);
});

test('LRU 缓存：超过 cacheChunks 就淘汰最久没碰的块；命中会续命', async () => {
  const a = await startServer('a', FILE);
  const f = fileOf(sourcesOf(a), { cacheChunks: 2 });
  await f.readChunk(0);
  await f.readChunk(1);
  await f.readChunk(0); // 触碰 0 → 淘汰顺序变成 1, 0
  await f.readChunk(2); // 淘汰 1
  await f.readChunk(0); // 仍在缓存
  await f.readChunk(1); // 要重取
  assert.equal(a.hitsFor(0), 1);
  assert.equal(a.hitsFor(1), 2);
  assert.equal(a.hitsFor(2), 1);
});

test('退避期间取消：signal 中止后立刻拒绝，在途数归零', async () => {
  const down = await startServer('down', FILE);
  const f = fileOf(sourcesOf(down), { retry: { baseDelayMs: 5000, maxDelayMs: 5000, budgetMs: 60000 } });
  await f.probeAll();
  down.mode.status = 500;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(f.readChunk(0, { signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(f.sources.stats('down').inFlight, 0);
});

// ── 审查后补的用例 ─────────────────────────────────────────────────

test('所有源 HEAD 都撒谎（说支持、GET 回 200）：取块时报 needs-whole 而不是 exhausted，needsWhole 翻真，downloadWhole 能走通', async () => {
  // 单源
  const liar = await startServer('liar', FILE, { range: 'ignore' });
  const f = fileOf(sourcesOf(liar));
  const summary = await f.probeAll();
  assert.equal(summary.needsWhole, false, 'HEAD 探测阶段被骗过');
  assert.equal(f.sources.stats('liar').rangeSupported, true);
  const e = await rejectsWithCode(f.readChunk(1), 'needs-whole');
  assert.equal(e.chunk, 1);
  assert.deepEqual(e.failures, { liar: ['range-ignored'] });
  assert.match(e.message, /liar：range-ignored/);
  assert.equal(f.needsWhole, true);
  assert.equal(f.sources.stats('liar').rangeSupported, false);
  assert.equal(liar.gets, 1, '揭穿之后不再对它分块重试');
  // 之后的分块读直接报 needs-whole，不再发请求
  await rejectsWithCode(f.readChunk(2), 'needs-whole');
  assert.equal(liar.gets, 1);
  assert.deepEqual(Buffer.from(await f.downloadWhole()), FILE);

  // 双源都撒谎（两家 CDN 规则配得一样）：并行读多块也得到同一个结论
  const l1 = await startServer('l1', FILE, { range: 'ignore' });
  const l2 = await startServer('l2', FILE, { range: 'ignore' });
  const g = fileOf(sourcesOf(l1, l2));
  assert.equal((await g.probeAll()).needsWhole, false);
  const outcomes = await Promise.allSettled([g.readChunk(0), g.readChunk(3), g.readChunk(7)]);
  for (const o of outcomes) {
    assert.equal(o.status, 'rejected');
    assert.equal(o.reason.code, 'needs-whole', o.reason.message);
  }
  assert.equal(g.needsWhole, true);
  assert.deepEqual(Buffer.from(await g.downloadWhole()), FILE);
  // 显式再探一次仍是 HEAD 的结论（被骗），但取块时会再次被揭穿
  await g.probeAll();
  assert.equal(g.needsWhole, false);
  await rejectsWithCode(g.readChunk(0), 'needs-whole');
});

test('一条撒谎、一条老实：仍是分块读，不会误报 needs-whole', async () => {
  const liar = await startServer('liar', FILE, { range: 'ignore' });
  const honest = await startServer('honest', FILE);
  const f = fileOf(new SourceSet([{ id: 'liar', url: liar.url, weight: 10 }, { id: 'honest', url: honest.url }]));
  await f.probeAll();
  assert.deepEqual(Buffer.from(await f.read(0, CHUNK * 4)), FILE.subarray(0, CHUNK * 4));
  assert.equal(f.needsWhole, false);
});

test('并行读多块时，已被别的块证明连败到阈值的源不再逐块各数三次', async () => {
  const hang = await startServer('hang', FILE);
  const ok = await startServer('ok', FILE);
  const f = fileOf(new SourceSet([{ id: 'hang', url: hang.url, weight: 10 }, { id: 'ok', url: ok.url }]), { timeoutMs: 100, cacheChunks: 0 });
  await f.probeAll();
  hang.mode.hang = 'body';
  const t0 = Date.now();
  const got = await f.read(0, CHUNK * 8);
  const elapsed = Date.now() - t0;
  assert.deepEqual(Buffer.from(got), FILE.subarray(0, CHUNK * 8));
  // 8 块第一轮都挑了它（weight 10）；连败数到 3 之后其余块直接换源，最多只有前两块各再试一次
  assert.ok(hang.gets <= 10, `卡死的源应只被请求 8 + 2 次以内，实际 ${hang.gets}（旧逻辑是 8 × 3 = 24）`);
  assert.ok(elapsed < 1000, `首字节延迟不该按块数放大，实际 ${elapsed} ms`);
  assert.ok(f.sources.stats('hang').consecutiveFailures >= 3);
});

test('首次自动探测与同块合并：各调用方带自己的 signal，A 取消不影响 B；全取消才真的中止请求', async () => {
  const a = await startServer('a', FILE, { delayMs: 60 });
  const f = fileOf(sourcesOf(a));
  // 未显式 probeAll：A、B 同时触发，等的是同一次探测；A 在探测期间取消
  const acA = new AbortController();
  const acB = new AbortController();
  const pA = f.readChunk(0, { signal: acA.signal });
  const pB = f.readChunk(1, { signal: acB.signal });
  setTimeout(() => acA.abort(), 10);
  await assert.rejects(pA, (e) => e.name === 'AbortError');
  assert.equal(acB.signal.aborted, false);
  assert.deepEqual(Buffer.from(await pB), FILE.subarray(CHUNK, CHUNK * 2));
  assert.equal(a.requests.filter((q) => q.method === 'HEAD').length, 1, '探测只发一次，B 不该重新探');

  // 同一块：A、B 合并成一次请求；A 取消，B 照样拿到数据，请求没有重发
  const acC = new AbortController();
  const acD = new AbortController();
  const pC = f.readChunk(3, { signal: acC.signal });
  const pD = f.readChunk(3, { signal: acD.signal });
  setTimeout(() => acC.abort(), 10);
  await assert.rejects(pC, (e) => e.name === 'AbortError');
  assert.deepEqual(Buffer.from(await pD), FILE.subarray(CHUNK * 3, CHUNK * 4));
  assert.equal(a.hitsFor(3), 1);

  // 全取消：请求真的被中止（服务端看到连接断开、在途数归零）；再读同一块要重新发起并成功
  const acE = new AbortController();
  const acF = new AbortController();
  const pE = f.readChunk(5, { signal: acE.signal });
  const pF = f.readChunk(5, { signal: acF.signal });
  setTimeout(() => {
    acE.abort();
    acF.abort();
  }, 10);
  await assert.rejects(pE, (e) => e.name === 'AbortError');
  await assert.rejects(pF, (e) => e.name === 'AbortError');
  assert.equal(f.sources.stats('a').inFlight, 0);
  const abortedBefore = a.counters.aborted;
  assert.deepEqual(Buffer.from(await f.readChunk(5)), FILE.subarray(CHUNK * 5, CHUNK * 6));
  assert.equal(a.hitsFor(5), 2, '被放弃的那次不复用，新调用重新发起');
  assert.ok(a.counters.aborted >= abortedBefore, '被放弃的请求应已中止');
  // 已中止的 signal 直接拒绝，不发请求
  const dead = new AbortController();
  dead.abort();
  await assert.rejects(f.readChunk(6, { signal: dead.signal }), (e) => e.name === 'AbortError');
  assert.equal(a.hitsFor(6), 0);
});

test('budgetMs 只算失败耗时：单块下载时间超过预算的慢源照样成功，不报 exhausted', async () => {
  // 每 30 ms 来 128 字节，一块 1024 字节要 200 多 ms；预算只有 50 ms，但那是失败预算
  const slow = await startServer('slow', FILE, { trickle: { size: 128, everyMs: 30 } });
  const f = fileOf(sourcesOf(slow), { retry: { budgetMs: 50, baseDelayMs: 1, maxDelayMs: 2 } });
  await f.probeAll();
  const t0 = Date.now();
  assert.deepEqual(Buffer.from(await f.readChunk(2)), FILE.subarray(CHUNK * 2, CHUNK * 3));
  assert.ok(Date.now() - t0 > 50, '这一块的下载本身就超过了预算');
});

test('onProgress：每块成功后有 kind:chunk 事件，带块号、源、字节数、耗时与尝试次数', async () => {
  const flaky = await startServer('flaky', FILE);
  const progress = [];
  const f = fileOf(sourcesOf(flaky), { onProgress: (e) => progress.push(e) });
  await f.probeAll();
  await f.readChunk(4);
  flaky.mode.failNext = 2;
  await f.readChunk(6);
  const ev4 = progress.find((p) => p.kind === 'chunk' && p.chunk === 4);
  const ev6 = progress.find((p) => p.kind === 'chunk' && p.chunk === 6);
  assert.ok(ev4 && ev6);
  assert.equal(ev4.source, 'flaky');
  assert.equal(ev4.bytes, CHUNK);
  assert.equal(ev4.attempts, 1);
  assert.ok(ev4.ms >= 0);
  assert.equal(ev6.attempts, 3, '两次 500 之后第三次才成功');
});

test('原地退避是指数序列：4 次 500 后恢复，总耗时 ≥ base × (1 + 2 + 4 + 8)', async () => {
  const flaky = await startServer('flaky', FILE);
  const f = fileOf(sourcesOf(flaky), { retry: { baseDelayMs: 20, maxDelayMs: 1000 } });
  await f.probeAll();
  flaky.mode.failNext = 4;
  const t0 = Date.now();
  assert.deepEqual(Buffer.from(await f.readChunk(9)), FILE.subarray(CHUNK * 9, CHUNK * 10));
  const elapsed = Date.now() - t0;
  // 定时器按毫秒截断，可能比标称早不到 1 ms，四次累计留几毫秒余量
  assert.ok(elapsed >= 20 * (1 + 2 + 4 + 8) - 5, `退避应累计 300 ms 左右，实际 ${elapsed} ms`);
  assert.ok(elapsed < 1500, `不该退避过头，实际 ${elapsed} ms`);
  assert.equal(flaky.hitsFor(9), 5);
});

test('默认 maxAttempts 随源数推导：三条源全挂时第三条也轮得到，失败点名三条', async () => {
  const d1 = await startServer('d1', FILE);
  const d2 = await startServer('d2', FILE);
  const d3 = await startServer('d3', FILE);
  const f = fileOf(sourcesOf(d1, d2, d3), { retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  await f.probeAll();
  d1.mode.status = 500;
  d2.mode.status = 502;
  d3.mode.status = 503;
  const e = await rejectsWithCode(f.readChunk(2), 'exhausted');
  assert.equal(e.attempts, 9, '3 条源 × 连败阈值 3');
  assert.deepEqual(Object.keys(e.failures).sort(), ['d1', 'd2', 'd3']);
  assert.match(e.message, /d3：http-503 ×3/);
  // 显式给的 maxAttempts 仍照给的算
  d1.mode.status = d2.mode.status = d3.mode.status = null;
  const g = fileOf(sourcesOf(d1, d2, d3), { retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 } });
  await g.probeAll();
  d1.mode.status = 500;
  d2.mode.status = 502;
  d3.mode.status = 503;
  assert.equal((await rejectsWithCode(g.readChunk(2), 'exhausted')).attempts, 4);
});
