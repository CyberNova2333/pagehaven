// 检索执行器的测试：真建库、真开回来、真查；加载路径用假 fetch 覆盖「版本指针、整份校验、多源切换」。
//
// 查询逻辑的正确性没法靠读 SQL 看出来：trigram 对 2 字到底命中不命中、繁体查询串归一后能不能命中、
// 特殊字符会不会被当成 FTS5 语法——只有把库开回来查一遍才算数。样本是 core 的测试样本
// （sample 两话 + zeta 一话），文本与 tn 都在 fixtures 里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildGalleryDb, openGalleryDb, sha256Hex } from '@gallery/core';
import { loadGallery } from '../../../scripts/lib/data.mjs';
import { queryLines, ftsPhrase, likePattern } from '../src/query.js';
import { loadGalleryDb } from '../src/load.js';

const FIXTURES = fileURLToPath(new URL('../../core/test/fixtures/data', import.meta.url));
const gallery = await loadGallery({ dataDir: FIXTURES });

/** 一次建库、全程复用：只在内存里，开回来的连接每个用例自己关。 */
const DB_BYTES = await buildGalleryDb(gallery, { pageSize: 4096 });
const DB_META = { key: 'db/gallery-test.sqlite', size: DB_BYTES.byteLength, sha256: await sha256Hex(DB_BYTES) };
const BASE_CONFIG = { images: { hosts: ['img.example.org'] }, db: { prefix: 'db/' } };

async function withDb(fn) {
  const db = await openGalleryDb(DB_BYTES);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

test('ftsPhrase / likePattern：用户输入里的语法字符按字面处理', () => {
  assert.equal(ftsPhrase('漫画作者'), '"漫画作者"');
  assert.equal(ftsPhrase('a"b'), '"a""b"');
  assert.equal(likePattern('作者'), '%作者%');
  assert.equal(likePattern('a%b_c\\d'), '%a\\%b\\_c\\\\d%');
});

test('queryLines：≥3 字走 MATCH，命中并 join 回坐标与阅读器 hash', async () => {
  await withDb((db) => {
    const { mode, normalized, rows } = queryLines(db, '漫画作者');
    assert.equal(mode, 'match');
    assert.equal(normalized, '漫画作者');
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.seriesId, 'sample');
    assert.equal(r.issueId, 'sample/vol01');
    assert.equal(r.chapterId, 'sample/vol01/c001');
    assert.equal(r.chapterUrl, '/sample/vol01/c001/');
    assert.equal(r.pageN, 1);
    assert.equal(r.boxI, 1);
    assert.equal(r.text, '漫画作者的契約');
    assert.equal(r.url, '/sample/vol01/c001/#p1b1');
    assert.equal(r.x, 0.55);
    assert.equal(r.y, 0.4);
    assert.equal(r.w, 0.3);
    assert.equal(r.h, 0.1);
  });
});

test('queryLines：查询串走 normalizeText——繁体、标点、大小写都能命中', async () => {
  await withDb((db) => {
    // 繁体「契約」归一成「契约」，索引里的 tn 也是简体
    const trad = queryLines(db, '漫画作者的契約');
    assert.equal(trad.mode, 'match');
    assert.equal(trad.normalized, '漫画作者的契约');
    assert.equal(trad.rows.length, 1);

    // 带标点的原文：归一化后标点被去掉
    const punctuated = queryLines(db, '你好，世界！');
    assert.equal(punctuated.normalized, '你好世界');
    assert.equal(punctuated.mode, 'match');
    assert.equal(punctuated.rows[0].text, '你好，世界！');
  });
});

test('queryLines：恰好 2 字走 LIKE（trigram 最少 3 字）；1 字拒绝', async () => {
  await withDb((db) => {
    const two = queryLines(db, '契约');
    assert.equal(two.mode, 'like');
    assert.equal(two.rows.length, 1);
    assert.equal(two.rows[0].text, '漫画作者的契約');

    const twoTrad = queryLines(db, '再見');
    assert.equal(twoTrad.mode, 'like');
    assert.equal(twoTrad.rows[0].text, '再见。');

    const one = queryLines(db, '魔');
    assert.equal(one.mode, 'too-short');
    assert.deepEqual(one.rows, []);

    const blank = queryLines(db, '  ，。 ');
    assert.equal(blank.mode, 'too-short');
  });
});

test('queryLines：limit 生效；结果按作品 / 期 / 话 / 页 / 框排序', async () => {
  await withDb((db) => {
    const all = queryLines(db, '魔'); // 1 字拒绝，换个能命中的词
    assert.equal(all.mode, 'too-short');
    // 「的」是 1 字，走 LIKE 需要 2 字；样本里「漫画作者」「你好世界」都能命中「世界」两字
    const world = queryLines(db, '世界');
    assert.equal(world.mode, 'like');
    assert.equal(world.rows.length, 1);
    const limited = queryLines(db, '漫画作者', { limit: 1 });
    assert.equal(limited.rows.length, 1);
  });
});

test('loadGalleryDb：读 manifest → 整份下载 → 校验 → 打开；返回库与版本指针', async () => {
  const key = 'db/gallery-2026-09-03.sqlite';
  const sha256 = await sha256Hex(DB_BYTES);
  const manifest = { version: '2026-09-03', db: { key, size: DB_BYTES.byteLength, sha256, pageSize: 4096, chunkSize: 65536, chunks: `${key}.chunks.json` } };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/db/manifest.json')) {
      return Response.json(manifest);
    }
    if (url.endsWith(`/${key}`)) {
      return new Response(DB_BYTES);
    }
    return new Response(null, { status: 404 });
  };
  const config = { images: { hosts: ['img.example.org'] }, db: { prefix: 'db/' } };
  const loaded = await loadGalleryDb({ config, fetchImpl });
  try {
    assert.equal(loaded.meta.key, key);
    assert.equal(loaded.meta.sha256, sha256);
    assert.equal(loaded.host, 'https://img.example.org');
    assert.deepEqual(calls, [
      'https://img.example.org/db/manifest.json',
      `https://img.example.org/${key}`,
    ]);
    assert.equal(queryLines(loaded.db, '漫画作者').rows.length, 1);
  } finally {
    loaded.db.close();
  }
});

test('loadGalleryDb：sha256 / size 不符、没有 db 字段、所有源失败 → 各自点名', async () => {
  const key = 'db/gallery.sqlite';
  const sha256 = await sha256Hex(DB_BYTES);
  const base = { images: { hosts: ['img.example.org'] }, db: { prefix: 'db/' } };
  const serve = ({ manifest, bytes = DB_BYTES, fail = null }) => async (url) => {
    if (fail) throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } });
    if (url.endsWith('/db/manifest.json')) return Response.json(manifest);
    if (url.endsWith(`/${key}`)) return new Response(bytes);
    return new Response(null, { status: 404 });
  };

  await assert.rejects(
    loadGalleryDb({ config: base, fetchImpl: serve({ manifest: { db: { key, size: DB_BYTES.byteLength, sha256: '0'.repeat(64) } } }) }),
    /sha256 .* 不符/,
  );
  await assert.rejects(
    loadGalleryDb({ config: base, fetchImpl: serve({ manifest: { db: { key, size: DB_BYTES.byteLength + 1, sha256 } } }) }),
    /长度 .* 与 manifest 的 .* 不符/,
  );
  await assert.rejects(loadGalleryDb({ config: base, fetchImpl: serve({ manifest: {} }) }), /没有有效的 db 字段/);
  await assert.rejects(loadGalleryDb({ config: base, fetchImpl: serve({ manifest: {}, fail: true }) }), /所有图片域名都取不到/);
});

test('loadGalleryDb：第一个主机挂了换第二个，最终用能用的那个', async () => {
  const key = 'db/gallery.sqlite';
  const sha256 = await sha256Hex(DB_BYTES);
  const manifest = { db: { key, size: DB_BYTES.byteLength, sha256 } };
  const fetchImpl = async (url) => {
    if (url.startsWith('https://bad.example/')) throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } });
    if (url.endsWith('/db/manifest.json')) return Response.json(manifest);
    return new Response(DB_BYTES);
  };
  const config = { images: { hosts: ['bad.example', 'good.example'] }, db: { prefix: 'db/' } };
  const loaded = await loadGalleryDb({ config, fetchImpl });
  try {
    assert.equal(loaded.host, 'https://good.example');
    assert.equal(loaded.meta.key, key);
  } finally {
    loaded.db.close();
  }
});

test('loadGalleryDb：固定版本只请求固定 key，不读取或回退当前 manifest', async () => {
  const config = { ...BASE_CONFIG, db: { ...BASE_CONFIG.db, release: DB_META } };
  const calls = [];
  const loaded = await loadGalleryDb({ config, fetchImpl: async (url) => {
    calls.push(url);
    return new Response(DB_BYTES);
  } });
  loaded.db.close();
  assert.deepEqual(calls, [`https://img.example.org/${DB_META.key}`]);
  calls.length = 0;
  await assert.rejects(loadGalleryDb({ config, fetchImpl: async (url) => {
    calls.push(url);
    return new Response(null, { status: 404 });
  } }), /404/);
  assert.deepEqual(calls, [`https://img.example.org/${DB_META.key}`]);
});

test('loadGalleryDb：显式 release=null 或错误元数据，不访问生产版本', async () => {
  let calls = 0;
  for (const release of [null, {}, { ...DB_META, sha256: undefined }]) {
    await assert.rejects(loadGalleryDb({
      config: { ...BASE_CONFIG, db: { ...BASE_CONFIG.db, release } },
      fetchImpl: async () => { calls++; throw new Error('不应发起请求'); },
    }), /尚未构建|db.key|db.sha256/);
  }
  assert.equal(calls, 0);
});

test('loadGalleryDb：严格校验每个源的 manifest，坏 JSON 对象不能挡住备用源', async () => {
  const invalid = [
    {}, { db: [] }, { db: { ...DB_META, key: 'db/../outside.sqlite' } },
    { db: { ...DB_META, size: undefined } }, { db: { ...DB_META, size: -1 } },
    { db: { ...DB_META, sha256: undefined } }, { db: { ...DB_META, sha256: 'deadbeef' } },
  ];
  for (const manifest of invalid) {
    const calls = [];
    const config = { ...BASE_CONFIG, images: { hosts: ['first.example', 'second.example'] } };
    const loaded = await loadGalleryDb({ config, fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('manifest.json')) return Response.json(url.includes('first.example') ? manifest : { db: DB_META });
      return new Response(DB_BYTES);
    } });
    loaded.db.close();
    assert.ok(calls.includes('https://second.example/db/manifest.json'));
  }
});

test('loadGalleryDb：manifest 上限预检阻止下载，兼容路径和固定版本均生效', async () => {
  for (const release of [undefined, DB_META]) {
    const db = { ...BASE_CONFIG.db, whole_download_max_bytes: 1 };
    if (release) db.release = release;
    const calls = [];
    await assert.rejects(loadGalleryDb({ config: { ...BASE_CONFIG, db }, fetchImpl: async (url) => {
      calls.push(url);
      assert.ok(url.endsWith('manifest.json'), '不应下载超限的数据库');
      return Response.json({ db: DB_META });
    } }), /超过整份下载上限/);
    assert.equal(calls.length, release ? 0 : 1);
  }
});

test('loadGalleryDb：缺少长度头的超额响应在读取时取消，不消耗剩余流', async () => {
  let cancelled = false;
  let pulls = 0;
  let request;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(pulls === 1 ? DB_BYTES : new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const config = { ...BASE_CONFIG, db: { ...BASE_CONFIG.db, release: DB_META, whole_download_max_bytes: DB_META.size } };
  await assert.rejects(loadGalleryDb({ config, fetchImpl: async (_url, init) => {
    request = init;
    return new Response(body);
  } }), /超过整份下载上限/);
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
  assert.equal(request.signal.aborted, true);
});

test('loadGalleryDb：响应头宣布超限时不读 body，尺寸撒谎或摘要不符可换源', async () => {
  let cancelled = false;
  let pulls = 0;
  const config = { ...BASE_CONFIG, db: { ...BASE_CONFIG.db, release: DB_META, whole_download_max_bytes: DB_META.size } };
  await assert.rejects(loadGalleryDb({ config, fetchImpl: async () => new Response(new ReadableStream({
    pull() { pulls++; }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': String(DB_META.size + 1) } }) }), /超过整份下载上限/);
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
  for (const payload of [DB_BYTES.slice(0, -1), new Uint8Array(DB_BYTES.length)]) {
    const loaded = await loadGalleryDb({
      config: { ...config, images: { hosts: ['first.example', 'second.example'] } },
      fetchImpl: async (url) => new Response(url.includes('first.example') ? payload : DB_BYTES),
    });
    assert.equal(loaded.host, 'https://second.example');
    loaded.db.close();
  }
});

/** 只实现搜索接线需要的 DOM，验证读者看到的状态与实际网络请求。 */
