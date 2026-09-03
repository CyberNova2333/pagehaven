// scripts/lib/r2.mjs 的单测：凭据判定、分页、404 → null、上传参数。
//
// 四个封装只依赖「一个有 send(cmd) 的对象」，所以这里用假 client 记录命令、按脚本回话——
// 验的是封装自己的约定（翻页到 IsTruncated 为 false、404 与其他错误分开、上传带缓存头），
// 不连任何外部服务。真 SDK 对着本地假服务器的端到端在 build-manifest / write-status 的测试里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, ListObjectsV2Command, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  R2_ENV_KEYS,
  r2Endpoint,
  r2ClientFromEnv,
  listAllKeys,
  listAllObjects,
  headObject,
  putObject,
} from '../lib/r2.mjs';

const FULL_ENV = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk', R2_BUCKET: 'bkt' };

/** 假 client：按顺序回放 responses，记录收到的每条命令。 */
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      calls.push(cmd);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(cmd);
      return r;
    },
  };
}

test('r2ClientFromEnv：四个变量缺任一个都返回 null，不抛', () => {
  assert.equal(r2ClientFromEnv({}), null);
  for (const k of R2_ENV_KEYS) {
    const env = { ...FULL_ENV };
    delete env[k];
    assert.equal(r2ClientFromEnv(env), null, `缺 ${k}`);
    assert.equal(r2ClientFromEnv({ ...FULL_ENV, [k]: '' }), null, `${k} 为空串`);
  }
});

test('r2ClientFromEnv：齐全时返回 S3 客户端 + 桶名 + 账号 + 端点；端点由账号拼出，路径式寻址', async () => {
  const r2 = r2ClientFromEnv(FULL_ENV);
  assert.ok(r2.client instanceof S3Client);
  assert.equal(r2.bucket, 'bkt');
  assert.equal(r2.accountId, 'acct');
  assert.equal(r2.endpoint, 'https://acct.r2.cloudflarestorage.com', '实际用的端点带回去，调用方抹日志用');
  const ep = await r2.client.config.endpoint();
  assert.equal(ep.protocol, 'https:');
  assert.equal(ep.hostname, 'acct.r2.cloudflarestorage.com');
  assert.equal(r2Endpoint('acct'), 'https://acct.r2.cloudflarestorage.com');
  assert.equal(r2.client.config.forcePathStyle, true);
  assert.equal(await r2.client.config.region(), 'auto');
  // 只在协议要求时算校验和：S3 之外的实现未必认 aws-chunked 的 CRC 尾部
  assert.equal(await r2.client.config.requestChecksumCalculation(), 'WHEN_REQUIRED');
  assert.equal(await r2.client.config.responseChecksumValidation(), 'WHEN_REQUIRED');
  const creds = await r2.client.config.credentials();
  assert.equal(creds.accessKeyId, 'ak');
  assert.equal(creds.secretAccessKey, 'sk');
});

test('r2ClientFromEnv：R2_ENDPOINT 覆盖端点（测试对本地假服务器、或换别家 S3 兼容存储）', async () => {
  const r2 = r2ClientFromEnv({ ...FULL_ENV, R2_ENDPOINT: 'http://127.0.0.1:9' });
  assert.equal(r2.endpoint, 'http://127.0.0.1:9');
  const ep = await r2.client.config.endpoint();
  assert.equal(ep.protocol, 'http:');
  assert.equal(ep.hostname, '127.0.0.1');
  assert.equal(ep.port, 9);
});

test('listAllKeys：按 NextContinuationToken 翻页直到 IsTruncated 为 false，Prefix 每页都带', async () => {
  const client = fakeClient([
    { Contents: [{ Key: 'img/a' }, { Key: 'img/b' }], IsTruncated: true, NextContinuationToken: 't1' },
    { Contents: [{ Key: 'img/c' }], IsTruncated: true, NextContinuationToken: 't2' },
    // 最后一页：IsTruncated 为 false 时即使带了 token 也要停
    { Contents: [{ Key: 'img/d' }], IsTruncated: false, NextContinuationToken: 'stale' },
    new Error('不该再请求第四页'),
  ]);
  assert.deepEqual(await listAllKeys(client, 'bkt', 'img/'), ['img/a', 'img/b', 'img/c', 'img/d']);
  assert.equal(client.calls.length, 3);
  for (const c of client.calls) {
    assert.ok(c instanceof ListObjectsV2Command);
    assert.equal(c.input.Bucket, 'bkt');
    assert.equal(c.input.Prefix, 'img/');
    assert.equal(c.input.MaxKeys, 1000);
  }
  assert.deepEqual(client.calls.map((c) => c.input.ContinuationToken), [undefined, 't1', 't2']);
});

test('listAllKeys / listAllObjects：空前缀（没有 Contents）得到空数组；对象带大小', async () => {
  assert.deepEqual(await listAllKeys(fakeClient([{ IsTruncated: false }]), 'bkt', 'db/'), []);
  assert.deepEqual(await listAllObjects(fakeClient([{ KeyCount: 0 }]), 'bkt', 'db/'), []);
  const client = fakeClient([
    { Contents: [{ Key: 'db/a.sqlite', Size: 4096 }], IsTruncated: true, NextContinuationToken: 'n' },
    { Contents: [{ Key: 'db/a.sqlite.chunks.json', Size: 300 }, { Key: 'db/no-size' }], IsTruncated: false },
  ]);
  assert.deepEqual(await listAllObjects(client, 'bkt', 'db/'), [
    { key: 'db/a.sqlite', size: 4096 },
    { key: 'db/a.sqlite.chunks.json', size: 300 },
    { key: 'db/no-size', size: 0 },
  ]);
  assert.deepEqual(client.calls.map((c) => c.input.ContinuationToken), [undefined, 'n']);
});

test('listAllKeys：存储报错原样抛出（鉴权失败不能被当成「空清单」）', async () => {
  const denied = Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
  await assert.rejects(listAllKeys(fakeClient([denied]), 'bkt', 'img/'), /Access Denied/);
});

test('headObject：存在 → { size, etag }；404 → null；其他错误照抛', async () => {
  const ok = fakeClient([{ ContentLength: 12345, ETag: '"abc"' }]);
  assert.deepEqual(await headObject(ok, 'bkt', 'img/x.avif'), { size: 12345, etag: '"abc"' });
  assert.ok(ok.calls[0] instanceof HeadObjectCommand);
  assert.deepEqual(ok.calls[0].input, { Bucket: 'bkt', Key: 'img/x.avif' });

  // SDK 对 HEAD 404 抛的是 name=NotFound 的异常（HEAD 没有响应体，没有 NoSuchKey 那种错误码）
  const notFound = Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  assert.equal(await headObject(fakeClient([notFound]), 'bkt', 'img/none'), null);
  const bareStatus = Object.assign(new Error('UnknownError'), {
    name: 'UnknownError',
    $metadata: { httpStatusCode: 404 },
  });
  assert.equal(await headObject(fakeClient([bareStatus]), 'bkt', 'img/none'), null);
  const noSuchKey = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
  assert.equal(await headObject(fakeClient([noSuchKey]), 'bkt', 'img/none'), null);

  const denied = Object.assign(new Error('Forbidden'), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });
  await assert.rejects(headObject(fakeClient([denied]), 'bkt', 'img/x'), /Forbidden/);
  await assert.rejects(headObject(fakeClient([new TypeError('fetch failed')]), 'bkt', 'img/x'), TypeError);
});

test('putObject：Bucket / Key / Body / ContentType / CacheControl 落到命令上，返回 etag', async () => {
  const client = fakeClient([{ ETag: '"put-etag"' }, { ETag: '"bare"' }]);
  const body = new Uint8Array([1, 2, 3]);
  const r = await putObject(client, 'bkt', 'img/s/i/c/1-0123456789ab.avif', body, {
    contentType: 'image/avif',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  assert.deepEqual(r, { etag: '"put-etag"' });
  const cmd = client.calls[0];
  assert.ok(cmd instanceof PutObjectCommand);
  assert.deepEqual(cmd.input, {
    Bucket: 'bkt',
    Key: 'img/s/i/c/1-0123456789ab.avif',
    Body: body,
    ContentType: 'image/avif',
    CacheControl: 'public, max-age=31536000, immutable',
  });
  // 元数据可省
  assert.deepEqual(await putObject(client, 'bkt', 'k', 'text'), { etag: '"bare"' });
  assert.equal(client.calls[1].input.ContentType, undefined);
  assert.equal(client.calls[1].input.CacheControl, undefined);
});
