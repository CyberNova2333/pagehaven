// 发布事务只用内存存储：验证环境隔离、成功凭据、条件启用与丢失响应后的重试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageError } from '../lib/r2.mjs';
import { activateRelease, deploymentReceipt, prepareRelease, releaseFingerprint, releasePlan, validateSecretImports } from '../lib/release.mjs';

const DOMAIN = 'gallery.unit-fixture.org';
const IMAGE_HOSTS = ['images.unit-fixture.org'];
const PREFIX = 'db/';
const CURRENT = `${PREFIX}manifest.json`;
const VERSIONED = `${PREFIX}manifest-release-1.json`;

function manifest(overrides = {}) {
  return {
    version: 'release-1',
    generatedAt: '2026-10-21T00:00:00Z',
    site: { domain: DOMAIN },
    db: { key: 'db/gallery-release-1.sqlite', sha256: 'a'.repeat(64), size: 8192 },
    series: [{ id: 'sample', chapters: [{ key: 'sample/one/one' }] }],
    ...overrides,
  };
}

function storage(seed = {}) {
  let sequence = 0;
  const objects = new Map();
  const calls = [];
  const fixture = {
    objects,
    calls,
    loseNextPutResponse: false,
    failNextGet: null,
    set(key, body) {
      const value = { body: Buffer.from(body), etag: `"revision-${++sequence}"` };
      objects.set(key, value);
      return value;
    },
    async request(method, bucket, key, options = {}) {
      assert.equal(bucket, 'unit-bucket');
      calls.push({ method, key, options });
      if (method === 'GET') {
        if (fixture.failNextGet) {
          const error = fixture.failNextGet;
          fixture.failNextGet = null;
          throw error;
        }
        const object = objects.get(key);
        if (!object) throw new StorageError('对象不存在', { status: 404 });
        return new Response(object.body, { headers: object.etag ? { etag: object.etag } : {} });
      }
      assert.equal(method, 'PUT');
      const existing = objects.get(key);
      const headers = options.headers ?? {};
      assert.ok(headers['if-match'] || headers['if-none-match'], '启用必须带条件');
      if ((headers['if-match'] && existing?.etag !== headers['if-match']) || (headers['if-none-match'] === '*' && existing)) {
        throw new StorageError('前置条件失败', { status: 412 });
      }
      const written = fixture.set(key, options.body);
      if (fixture.loseNextPutResponse) {
        fixture.loseNextPutResponse = false;
        throw new StorageError('写入已完成但响应丢失', { status: 0 });
      }
      return new Response(null, { headers: { etag: written.etag } });
    },
  };
  for (const [key, body] of Object.entries(seed)) fixture.set(key, body);
  return fixture;
}

function context({ target = 'all', environment = 'production', previous = '{"version":"previous"}', published = JSON.stringify(manifest()) } = {}) {
  const data = manifest();
  const plan = releasePlan({ target, environment, domain: DOMAIN, imageHosts: IMAGE_HOSTS });
  const client = storage({ ...(previous === null ? {} : { [CURRENT]: previous }), ...(published === null ? {} : { [VERSIONED]: published }) });
  const args = { client, bucket: 'unit-bucket', prefix: PREFIX, manifest: data, plan };
  const receipts = plan.targets.map((name) => deploymentReceipt(data, name, environment));
  return { ...args, receipts };
}

test('releasePlan：生产目标展开，预览与仅上传不能启用，GitHub 预览与示例生产域名被拒绝', () => {
  assert.deepEqual(releasePlan({ target: 'all', domain: DOMAIN, imageHosts: IMAGE_HOSTS }).targets, ['cloudflare', 'edgeone', 'github']);
  assert.equal(releasePlan({ target: 'none', domain: 'gallery.example.org' }).activate, false);
  assert.equal(releasePlan({ target: 'edgeone', environment: 'preview', domain: 'gallery.example.org' }).activate, false);
  for (const target of ['github', 'all']) assert.throws(() => releasePlan({ target, environment: 'preview', domain: DOMAIN }), /独立预览目标/);
  for (const domain of [undefined, 'gallery.example.org', 'example.com', 'localhost', 'gallery.invalid']) {
    assert.throws(() => releasePlan({ target: 'edgeone', domain }), /正式站点域名/);
  }
  assert.throws(() => releasePlan({ target: 'unknown', domain: DOMAIN }), /目标无效/);
  assert.throws(() => releasePlan({ target: 'edgeone', environment: '$deploy_env', domain: DOMAIN }), /部署环境/);
});

test('releasePlan：生产部署拒绝缺失或任一占位图片域名，预览和仅上传仍允许模板配置', () => {
  for (const imageHosts of [undefined, [], ['images.example.org'], ['images.example.com'], ['images.example.net'], ['images.test'], ['images.invalid'], ['localhost'], [...IMAGE_HOSTS, 'backup.example.org']]) {
    assert.throws(() => releasePlan({ target: 'all', domain: DOMAIN, imageHosts }), /正式图片域名/);
  }
  for (const target of ['cloudflare', 'edgeone', 'github', 'all']) {
    assert.equal(releasePlan({ target, domain: DOMAIN, imageHosts: IMAGE_HOSTS }).activate, true);
  }
  assert.equal(releasePlan({ target: 'cloudflare', environment: 'preview', domain: 'gallery.example.org', imageHosts: ['images.example.org'] }).activate, false);
  assert.equal(releasePlan({ target: 'none', domain: 'gallery.example.org', imageHosts: ['images.example.org'] }).activate, false);
});

test('密钥文件参数：上传始终必填、部署按目标必填，兼容自托管 CNB 地址', () => {
  const publishUrl = 'https://cnb.cool/unit-group/unit-secrets/-/blob/main/publish.yml';
  const deployUrl = 'https://code.unit-fixture.org/unit-group/unit-secrets/-/blob/main/deploy.json';
  assert.doesNotThrow(() => validateSecretImports({ publishUrl, target: 'none' }));
  for (const target of ['cloudflare', 'edgeone', 'github', 'all']) {
    assert.doesNotThrow(() => validateSecretImports({ publishUrl, deployUrl, target }));
    assert.throws(() => validateSecretImports({ publishUrl, target }), /deploy_secrets_url/);
  }
  assert.throws(() => validateSecretImports({ deployUrl, target: 'none' }), /publish_secrets_url/);
});

test('密钥文件参数：拒绝非 HTTPS、非文件地址和嵌入凭据，错误不回显输入', () => {
  const valid = 'https://cnb.cool/unit-group/unit-secrets/-/blob/main/publish.yml';
  for (const publishUrl of ['', 'not-a-url', valid.replace('https:', 'http:'), valid.replace('/blob/', '/tree/'), `${valid}?token=private-value`, `${valid}#private-value`, valid.replace('https://', 'https://private-value@'), ` ${valid}`]) {
    assert.throws(() => validateSecretImports({ publishUrl, target: 'none' }), (error) => {
      assert.match(error.message, /publish_secrets_url/);
      assert.doesNotMatch(error.message, /private-value|unit-secrets/);
      return true;
    });
  }
});

test('releaseFingerprint：属性排序与生成时间不改变指纹，数据与版本变化改变指纹', () => {
  const original = manifest();
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.db = Object.fromEntries(Object.entries(original.db).reverse());
  reordered.generatedAt = '2030-01-01T00:00:00Z';
  assert.equal(releaseFingerprint(original), releaseFingerprint(reordered));
  assert.notEqual(releaseFingerprint(original), releaseFingerprint(manifest({ version: 'release-2' })));
  assert.notEqual(releaseFingerprint(original), releaseFingerprint(manifest({ series: [] })));
});

test('preview 与 none：prepare 和被拒绝的 activate 对对象存储均为零读写', async () => {
  for (const options of [{ target: 'edgeone', environment: 'preview' }, { target: 'none' }, { target: 'none', environment: 'preview' }]) {
    const args = context(options);
    const state = await prepareRelease(args);
    assert.equal(state.previous, null);
    assert.equal(state.etag, null);
    await assert.rejects(activateRelease({ ...args, state }), /不能启用生产版本/);
    assert.equal(args.client.calls.length, 0);
  }
});

test('prepare：保存旧 manifest 原文字节和同次 GET 的 ETag；缺 ETag 或读取失败时停止', async () => {
  const text = '{\n "version": "旧版"\n}\n  ';
  const args = context({ previous: text });
  const state = await prepareRelease(args);
  assert.equal(state.previous, text);
  assert.equal(state.etag, args.client.objects.get(CURRENT).etag);
  assert.deepEqual(args.client.calls.map((r) => [r.method, r.key]), [['GET', CURRENT]]);
  const absent = context({ previous: null });
  const initial = await prepareRelease(absent);
  assert.equal(initial.previous, null);
  assert.equal(initial.etag, null);
  const missingEtag = context();
  delete missingEtag.client.objects.get(CURRENT).etag;
  await assert.rejects(prepareRelease(missingEtag), /缺少 ETag/);
  const denied = context();
  denied.client.failNextGet = new StorageError('拒绝读取', { status: 403 });
  await assert.rejects(prepareRelease(denied), /拒绝读取/);
});

test('activate：全部目标有本版成功记录才启用；缺失、旧版本、旧指纹或预览记录在访问存储前拒绝', async () => {
  for (const kind of ['missing', 'version', 'fingerprint', 'environment']) {
    const args = context();
    const state = await prepareRelease(args);
    args.client.calls.length = 0;
    const receipts = args.receipts.map((r) => ({ ...r }));
    if (kind === 'missing') receipts.pop();
    else receipts[2][kind] = kind === 'environment' ? 'preview' : 'stale';
    await assert.rejects(activateRelease({ ...args, state, receipts }), /缺少本版本的成功部署记录/);
    assert.equal(args.client.calls.length, 0, kind);
  }
  const args = context();
  const state = await prepareRelease(args);
  const body = await activateRelease({ ...args, state });
  assert.deepEqual(args.client.objects.get(CURRENT).body, body);
  const writes = args.client.calls.filter((r) => r.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.headers['if-match'], state.etag);
  assert.equal(writes[0].options.headers['cache-control'], 'public, max-age=300');
});

test('activate：准备记录属于其他版本、目标或环境时拒绝且无存储操作', async () => {
  for (const field of ['version', 'fingerprint', 'target', 'environment']) {
    const args = context();
    const state = await prepareRelease(args);
    args.client.calls.length = 0;
    state[field] = 'other';
    await assert.rejects(activateRelease({ ...args, state }), /发布准备记录/);
    assert.equal(args.client.calls.length, 0, field);
  }
});

test('activate：不存在或内容不一致的不可变清单不能启用，不覆盖当前版本', async () => {
  for (const published of [null, JSON.stringify(manifest({ series: [] })), JSON.stringify(manifest({ version: 'other' })), '{broken']) {
    const args = context({ published });
    const state = await prepareRelease(args);
    const before = Buffer.from(args.client.objects.get(CURRENT).body);
    await assert.rejects(activateRelease({ ...args, state }));
    assert.deepEqual(args.client.objects.get(CURRENT).body, before);
    assert.equal(args.client.calls.filter((r) => r.method === 'PUT').length, 0);
  }
});

test('activate：相同发布的生成时间可不同，始终启用存储中的原文；首次发布使用 If-None-Match', async () => {
  const published = JSON.stringify(manifest({ generatedAt: '2026-01-01T00:00:00Z' }), null, 4) + '\n  ';
  const args = context({ previous: null, published });
  const state = await prepareRelease(args);
  await activateRelease({ ...args, state });
  assert.deepEqual(args.client.objects.get(CURRENT).body, Buffer.from(published));
  const write = args.client.calls.find((r) => r.method === 'PUT');
  assert.equal(write.options.headers['if-none-match'], '*');
  assert.equal(write.options.headers['if-match'], undefined);
});

test('activate：准备后另一发布抢先启用，已有与首次发布两种场景都拒绝覆盖', async () => {
  for (const previous of [null, '{"version":"previous"}']) {
    const args = context({ previous });
    const state = await prepareRelease(args);
    const winner = args.client.set(CURRENT, '{"version":"concurrent-winner"}');
    await assert.rejects(activateRelease({ ...args, state }), /生产版本已变化/);
    assert.deepEqual(args.client.objects.get(CURRENT), winner);
    assert.equal(args.client.calls.filter((r) => r.method === 'PUT').length, 1);
  }
});

test('activate：PUT 成功但回应丢失后，原准备记录重试可幂等完成，不重写胜出对象', async () => {
  const args = context();
  const state = await prepareRelease(args);
  args.client.loseNextPutResponse = true;
  await assert.rejects(activateRelease({ ...args, state }), /响应丢失/);
  const committed = args.client.objects.get(CURRENT);
  const result = await activateRelease({ ...args, state });
  assert.deepEqual(result, committed.body);
  assert.equal(args.client.objects.get(CURRENT).etag, committed.etag);
  assert.equal(args.client.calls.filter((r) => r.method === 'PUT').length, 2);
});
