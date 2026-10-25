// scripts/lib/r2.mjs 的单测：贴凭据判定、SigV4 签名、分页、404 → null、上传参数。
//
// 分两层：签名是纯函数，拿固定向量比对；四个封装依赖「有一个 request(method, bucket, key, opts)
// 的对象」，所以这里用假 client 回放 XML / 字节、记录每次请求——验的是封装自己的约定（翻页到
// IsTruncated 为 false、404 与其他错误分开、上传带缓存头）。客户端对着本地假服务器的真请求在
// 本文件末尾，另有两个脚本级端到端（build-manifest / write-status / publish-plan）也走真 HTTP。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  R2_ENV_KEYS,
  r2Endpoint,
  r2ClientFromEnv,
  createStorage,
  signV4,
  StorageError,
  listAllKeys,
  listAllObjects,
  headObject,
  getObjectText,
  getObject,
  putObject,
  putImmutableObject,
} from '../lib/r2.mjs';

const FULL_ENV = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk', R2_BUCKET: 'bkt' };

/** 假 client：按顺序回放 responses，记录每次 (method, bucket, key, opts)。 */
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    async request(method, bucket, key, opts = {}) {
      calls.push({ method, bucket, key, opts });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(method, bucket, key, opts);
      return r;
    },
  };
}

/** response 的最小形状：封装只用到 text() / headers.get()。 */
const jsonResponse = (text, headers = {}) => ({
  text: async () => text,
  arrayBuffer: async () => Buffer.from(text),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

test('r2ClientFromEnv：四个变量缺任一个都返回 null，不抛', () => {
  assert.equal(r2ClientFromEnv({}), null);
  for (const k of R2_ENV_KEYS) {
    const env = { ...FULL_ENV };
    delete env[k];
    assert.equal(r2ClientFromEnv(env), null, `缺 ${k}`);
    assert.equal(r2ClientFromEnv({ ...FULL_ENV, [k]: '' }), null, `${k} 为空串`);
  }
});

test('r2ClientFromEnv：齐全时返回客户端 + 桶名 + 账号 + 端点；端点由账号拼出，路径式寻址', () => {
  const r2 = r2ClientFromEnv(FULL_ENV);
  assert.equal(typeof r2.client.request, 'function');
  assert.equal(r2.bucket, 'bkt');
  assert.equal(r2.accountId, 'acct');
  assert.equal(r2.endpoint, 'https://acct.r2.cloudflarestorage.com', '实际用的端点带回去，调用方抹日志用');
  assert.equal(r2.client.host, 'acct.r2.cloudflarestorage.com', '桶名不进主机名');
  assert.equal(r2Endpoint('acct'), 'https://acct.r2.cloudflarestorage.com');
});

test('r2ClientFromEnv：R2_ENDPOINT 覆盖端点（测试对本地假服务器、或换别家 S3 兼容存储）', () => {
  const r2 = r2ClientFromEnv({ ...FULL_ENV, R2_ENDPOINT: 'http://127.0.0.1:9' });
  assert.equal(r2.endpoint, 'http://127.0.0.1:9');
  assert.equal(r2.client.host, '127.0.0.1:9');
  assert.throws(() => createStorage({ endpoint: 'ftp://x', accessKeyId: 'a', secretAccessKey: 'b' }), /http\(s\)/);
});

// 下面两个向量由官方签名实现（@smithy/signature-v4，S3 用的那一套）对同一组输入算出，
// 密钥与会话都是虚构的。两份独立实现得到同一个签名，才算对——自己跟自己对不算。
const VECTOR = {
  host: 'acct.r2.cloudflarestorage.com',
  date: '2026-10-20T02:41:50.000Z',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'not-a-real-secret/+==',
};

test('signV4：列对象请求的签名与官方实现逐字节一致', () => {
  const { authorization, amzDate } = signV4({
    ...VECTOR,
    method: 'GET',
    canonicalUri: '/bkt/',
    query: [
      ['list-type', '2'],
      ['prefix', 'db/'],
      ['max-keys', '1000'],
    ],
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.equal(amzDate, '20261020T024150Z');
  assert.equal(
    authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261020/auto/s3/aws4_request, ' +
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
      'Signature=bd01d468fbabadb1bf819396472005366ec896f05d0a5202e94bfc21871b6437',
  );
});

test('signV4：带中文与空格的 key 的 PUT，签名与官方实现逐字节一致', () => {
  const body = Buffer.from([0, 1, 2, 255]);
  const { authorization } = signV4({
    ...VECTOR,
    method: 'PUT',
    // key 的每个路径段各自按 RFC 3986 编码，分隔斜杠保持原样
    canonicalUri: '/bkt/img/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/a%20b.avif',
    query: [],
    payloadHash: createHash('sha256').update(body).digest('hex'),
  });
  assert.equal(
    authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261020/auto/s3/aws4_request, ' +
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
      'Signature=20e358f5ec1b8fe984e539d24dcec3259ea13b3bbc885e8d2f3959e9b2e73947',
  );
});

test('listAllKeys：按 NextContinuationToken 翻页直到 IsTruncated 为 false，Prefix 每页都带', async () => {
  const page = (keys, truncated, token) =>
    jsonResponse(
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (token ? `<NextContinuationToken>${token}</NextContinuationToken>` : '') +
        keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('') +
        '</ListBucketResult>',
    );
  const client = fakeClient([
    page(['img/a', 'img/b'], true, 't1'),
    page(['img/c'], true, 't2'),
    // 最后一页：IsTruncated 为 false 时即使带了 token 也要停
    page(['img/d'], false, 'stale'),
    new Error('不该再请求第四页'),
  ]);
  assert.deepEqual(await listAllKeys(client, 'bkt', 'img/'), ['img/a', 'img/b', 'img/c', 'img/d']);
  assert.equal(client.calls.length, 3);
  for (const c of client.calls) {
    assert.equal(c.method, 'GET');
    assert.equal(c.bucket, 'bkt');
    assert.equal(c.key, '', '列对象打的是桶本身');
    assert.deepEqual(c.opts.query.slice(0, 3), [['list-type', '2'], ['prefix', 'img/'], ['max-keys', '1000']]);
  }
  assert.deepEqual(
    client.calls.map((c) => c.opts.query.find(([k]) => k === 'continuation-token')?.[1]),
    [undefined, 't1', 't2'],
  );
});

test('listAllKeys / listAllObjects：空清单得到空数组；对象带大小；XML 实体与转义 key 还原', async () => {
  const empty = () => jsonResponse('<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>');
  assert.deepEqual(await listAllKeys(fakeClient([empty()]), 'bkt', 'db/'), []);
  assert.deepEqual(await listAllObjects(fakeClient([empty()]), 'bkt', 'db/'), []);
  const xml =
    '<ListBucketResult><IsTruncated>false</IsTruncated>' +
    '<Contents><Key>db/a&amp;b.sqlite</Key><Size>4096</Size></Contents>' +
    '<Contents><Key>db/无大小</Key></Contents>' +
    '</ListBucketResult>';
  assert.deepEqual(await listAllObjects(fakeClient([jsonResponse(xml)]), 'bkt', 'db/'), [
    { key: 'db/a&b.sqlite', size: 4096 },
    { key: 'db/无大小', size: 0 },
  ]);
});

test('listAllKeys：存储报错原样抛出（鉴权失败不能被当成「空清单」）', async () => {
  const denied = new StorageError('GET  失败：HTTP 403 AccessDenied Access Denied', { status: 403, code: 'AccessDenied' });
  await assert.rejects(listAllKeys(fakeClient([denied]), 'bkt', 'img/'), /AccessDenied/);
});

test('headObject：存在 → { size, etag }；404 → null；其他错误照抛', async () => {
  const ok = fakeClient([jsonResponse('', { 'content-length': '12345', etag: '"abc"' })]);
  assert.deepEqual(await headObject(ok, 'bkt', 'img/x.avif'), { size: 12345, etag: '"abc"' });
  assert.equal(ok.calls[0].method, 'HEAD');
  assert.equal(ok.calls[0].key, 'img/x.avif');

  const notFound = new StorageError('HEAD img/none 失败：HTTP 404 NotFound', { status: 404, code: 'NotFound' });
  assert.equal(await headObject(fakeClient([notFound]), 'bkt', 'img/none'), null);
  // 服务端只给状态码不给错误码（HEAD 没有响应体）时也要认 404
  const bare = new StorageError('HEAD img/none 失败：HTTP 404', { status: 404 });
  assert.equal(await headObject(fakeClient([bare]), 'bkt', 'img/none'), null);

  const denied = new StorageError('HEAD img/x 失败：HTTP 403 Forbidden', { status: 403, code: 'Forbidden' });
  await assert.rejects(headObject(fakeClient([denied]), 'bkt', 'img/x'), /Forbidden/);
  await assert.rejects(headObject(fakeClient([new TypeError('fetch failed')]), 'bkt', 'img/x'), TypeError);
});

test('getObjectText：有 → 文本；404 → null；其他错误照抛', async () => {
  assert.equal(await getObjectText(fakeClient([jsonResponse('{"a":1}')]), 'bkt', 'db/manifest.json'), '{"a":1}');
  const nf = new StorageError('GET db/manifest.json 失败：HTTP 404 NoSuchKey', { status: 404, code: 'NoSuchKey' });
  assert.equal(await getObjectText(fakeClient([nf]), 'bkt', 'db/manifest.json'), null);
  const forbidden = new StorageError('GET x 失败：HTTP 403', { status: 403 });
  await assert.rejects(getObjectText(fakeClient([forbidden]), 'bkt', 'x'), /403/);
});

test('putObject：正文、ContentType、CacheControl 落到请求上，返回 etag', async () => {
  const client = fakeClient([jsonResponse('', { etag: '"put-etag"' }), jsonResponse('')]);
  const body = new Uint8Array([1, 2, 3]);
  const r = await putObject(client, 'bkt', 'img/s/i/c/1-0123456789ab.avif', body, {
    contentType: 'image/avif',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  assert.deepEqual(r, { etag: '"put-etag"' });
  const call = client.calls[0];
  assert.equal(call.method, 'PUT');
  assert.equal(call.key, 'img/s/i/c/1-0123456789ab.avif');
  assert.equal(call.opts.body, body);
  assert.deepEqual(call.opts.headers, {
    'content-type': 'image/avif',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  // 元数据可省：不给就不带头
  assert.deepEqual(await putObject(client, 'bkt', 'k', 'text'), { etag: undefined });
  assert.deepEqual(client.calls[1].opts.headers, {});
});

test('getObject：正文与 ETag 来自同一次 GET，支持摘要元数据，非 404 错误不吞', async () => {
  const hash = 'ab'.repeat(32);
  const client = fakeClient([jsonResponse('正文', { etag: '"v1"', 'x-amz-meta-sha256': hash })]);
  assert.deepEqual(await getObject(client, 'bkt', 'key'), { body: Buffer.from('正文'), size: 6, etag: '"v1"', sha256: hash });
  assert.equal(client.calls.length, 1);
  assert.equal(await getObject(fakeClient([new StorageError('missing', { status: 404 })]), 'bkt', 'key'), null);
  await assert.rejects(getObject(fakeClient([new StorageError('denied', { status: 403 })]), 'bkt', 'key'), /denied/);
});

test('putObject：条件与摘要进入请求，拒绝空条件及互斥条件', async () => {
  const client = fakeClient([jsonResponse(''), jsonResponse('')]);
  await putObject(client, 'bkt', 'key', 'body', { ifNoneMatch: '*', sha256: 'ab'.repeat(32) });
  assert.equal(client.calls[0].opts.headers['if-none-match'], '*');
  assert.equal(client.calls[0].opts.headers['x-amz-meta-sha256'], 'ab'.repeat(32));
  await putObject(client, 'bkt', 'key', 'body', { ifMatch: '"previous"' });
  assert.equal(client.calls[1].opts.headers['if-match'], '"previous"');
  await assert.rejects(putObject(client, 'bkt', 'key', 'body', { ifMatch: '', ifNoneMatch: '*' }), /不能同时/);
  await assert.rejects(putObject(client, 'bkt', 'key', 'body', { ifMatch: '' }), /非空/);
  await assert.rejects(putObject(client, 'bkt', 'key', 'body', { sha256: 'invalid' }), /64 位/);
});

test('putImmutableObject：同内容不写，不同内容拒绝，首次写入有原子条件和摘要', async () => {
  const existing = fakeClient([jsonResponse('same', { etag: '"old"' })]);
  assert.deepEqual(await putImmutableObject(existing, 'bkt', 'key', 'same'), { created: false, etag: '"old"', body: Buffer.from('same') });
  assert.equal(existing.calls.length, 1);
  const different = fakeClient([jsonResponse('old')]);
  await assert.rejects(putImmutableObject(different, 'bkt', 'key', 'new'), /不可变对象.*内容不同/);
  assert.equal(different.calls.length, 1);
  const absent = fakeClient([new StorageError('missing', { status: 404 }), jsonResponse('', { etag: '"new"' })]);
  const created = await putImmutableObject(absent, 'bkt', 'key', 'same');
  assert.equal(created.created, true);
  assert.equal(absent.calls[1].opts.headers['if-none-match'], '*');
  assert.equal(absent.calls[1].opts.headers['x-amz-meta-sha256'], createHash('sha256').update('same').digest('hex'));
});

test('putImmutableObject：并发抢写 412 后核对胜出对象，未知写入结果不降级为覆盖', async () => {
  const missing = () => new StorageError('missing', { status: 404 });
  const conflict = () => new StorageError('condition failed', { status: 412 });
  const same = fakeClient([missing(), conflict(), jsonResponse('same', { etag: '"winner"' })]);
  assert.equal((await putImmutableObject(same, 'bkt', 'key', 'same')).etag, '"winner"');
  assert.deepEqual(same.calls.map((c) => c.method), ['GET', 'PUT', 'GET']);
  const different = fakeClient([missing(), conflict(), jsonResponse('other')]);
  await assert.rejects(putImmutableObject(different, 'bkt', 'key', 'same'), /内容不同/);
  const uncertain = fakeClient([missing(), new StorageError('connection lost', { status: 0 })]);
  await assert.rejects(putImmutableObject(uncertain, 'bkt', 'key', 'same'), /connection lost/);
  assert.deepEqual(uncertain.calls.map((c) => c.method), ['GET', 'PUT']);
});

/**
 * 本地假 S3：收请求、把 method / path / query / 头 / 正文记下来，按 handler 回话。
 * 这里验的是「客户端真的发了一个签过名、路径式寻址、正文完整的 HTTP 请求」。
 */
async function fakeServer(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('客户端：真发 HTTP —— 路径式寻址、key 转义、签名头齐、PUT 正文完整、4xx 变 StorageError', async (t) => {
  const s3 = await fakeServer((req, res) => {
    if (req.method === 'PUT') {
      res.writeHead(200, { etag: '"etag-from-server"' });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/bkt/db/manifest.json') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('你好');
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>nope</Message></Error>');
  });
  t.after(() => s3.close());
  const client = createStorage({ endpoint: s3.endpoint, accessKeyId: 'ak', secretAccessKey: 'sk' });

  // 上传：key 里的中文与空格按 RFC 3986 编码成路径段，桶名在路径第一位
  const put = await putObject(client, 'bkt', 'img/中文 目录/a b.avif', new Uint8Array([1, 2, 3]), {
    contentType: 'image/avif',
    cacheControl: 'public, max-age=31536000, immutable',
    ifNoneMatch: '*',
    sha256: createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'),
  });
  assert.deepEqual(put, { etag: '"etag-from-server"' });
  const upload = s3.seen[0];
  assert.equal(upload.method, 'PUT');
  assert.equal(upload.url, '/bkt/img/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/a%20b.avif');
  assert.equal(upload.headers['content-type'], 'image/avif');
  assert.equal(upload.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(upload.headers['if-none-match'], '*');
  assert.equal(upload.headers['x-amz-meta-sha256'], upload.headers['x-amz-content-sha256']);
  assert.deepEqual([...upload.body], [1, 2, 3]);
  // SigV4 的三个硬要求：算法与凭证范围、签的头全小写有序并声明、正文摘要与实际正文一致
  assert.match(upload.headers.authorization, /^AWS4-HMAC-SHA256 Credential=ak\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256, Signature=[0-9a-f]{64}$/);
  assert.equal(
    upload.headers['x-amz-content-sha256'],
    createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'),
    '摘要必须对得上正文，否则真存储会拒',
  );
  assert.match(upload.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  assert.equal(upload.headers.host, new URL(s3.endpoint).host);

  // 读：UTF-8 正文原样返回
  assert.equal(await getObjectText(client, 'bkt', 'db/manifest.json'), '你好');

  // 4xx → StorageError，带上状态码与 S3 的错误码；404 走封装的 null 分支
  const err = await client.request('GET', 'bkt', 'db/none.json').then(
    () => assert.fail('403 不该被当成成功'),
    (e) => e,
  );
  assert.ok(err instanceof StorageError);
  assert.equal(err.status, 403);
  assert.equal(err.name, 'AccessDenied');
  assert.match(err.message, /HTTP 403 AccessDenied nope/);
  // 404 走封装的 null 分支：这个假存储对 HEAD 回 404（没有响应体，只有状态码）
  assert.equal(await headObject(client, 'bkt', 'db/none.json'), null);
});
