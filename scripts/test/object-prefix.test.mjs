// 同一配置依次通过发布计划、真实库摘要和浏览器加载，防止各层各自通过却无法交接。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildGalleryDb, computeChunkManifest } from '@gallery/core';
import { parseSiteConfig } from '@gallery/platform';
import { loadGalleryDb } from '../../packages/search/src/load.js';
import { queryLines } from '../../packages/search/src/query.js';
import { loadGallery } from '../lib/data.mjs';
import { buildManifest } from '../lib/manifest.mjs';
import { dbFileNames, planUploads, verifyDbArtifacts } from '../lib/publish-plan.mjs';

const template = parseSiteConfig(await readFile(new URL('../../site.config.yaml', import.meta.url), 'utf8'));
const gallery = await loadGallery({ dataDir: fileURLToPath(new URL('../../packages/core/test/fixtures/data/', import.meta.url)) });
const bytes = await buildGalleryDb(gallery, { pageSize: template.db.page_size });
const chunks = await computeChunkManifest(bytes, template.db.chunk_size);
const version = 'prefix-test';
const names = dbFileNames(version);
const files = { db: [names.db, names.chunks], dbSize: bytes.byteLength, manifest: 'manifest.json', distArchive: 'site.tar.zst', images: null };

function release(config) {
  return {
    ...buildManifest(gallery, config, { version }),
    db: { version, key: config.db.prefix + names.db, chunks: config.db.prefix + names.chunks,
      size: bytes.byteLength, sha256: chunks.sha256, pageSize: config.db.page_size, chunkSize: config.db.chunk_size },
  };
}

test('对象前缀：安全配置能经过发布计划和字节校验，再由浏览器实际查询', async () => {
  for (const prefix of ['db/', 'search-v2/', 'Search_2/v1.0/']) {
    const raw = structuredClone(template);
    raw.db.prefix = prefix;
    const config = parseSiteConfig(JSON.stringify(raw));
    const manifest = release(config);
    const plan = planUploads({ version, config, manifest, files });
    assert.equal(plan.uploads.find((upload) => upload.kind === 'db').key, manifest.db.key);
    await verifyDbArtifacts({ manifest, dbConfig: config.db, dbBytes: bytes, chunksBytes: Buffer.from(JSON.stringify(chunks)) });
    for (const pinned of [false, true]) {
      const calls = [];
      const loaded = await loadGalleryDb({ config: { ...config, db: { ...config.db, ...(pinned ? { release: manifest.db } : {}) } },
        fetchImpl: async (url) => {
          calls.push(url);
          return url.endsWith('manifest.json') ? Response.json(manifest) : new Response(bytes);
        },
      });
      try {
        assert.equal(queryLines(loaded.db, '漫画作者').rows.length, 1);
        assert.deepEqual(calls, [
          ...(!pinned ? [`https://${config.images.hosts[0]}/${prefix}manifest.json`] : []),
          `https://${config.images.hosts[0]}/${manifest.db.key}`,
        ]);
      } finally { loaded.db.close(); }
    }
  }
});

test('对象前缀：配置与直接调用方一致拒绝不支持的路径，浏览器零网络请求', async () => {
  for (const prefix of ['检索/', 'search v2/', 'db/../old/', 'db/./', 'db//', '/db/', 'db',
    'db\\old/', 'db/%2e%2e/', 'https://storage.example.org/', 'db/?/', 'db/#/', 'db/\n/']) {
    const config = structuredClone(template);
    config.db.prefix = prefix;
    const manifest = release(config);
    assert.throws(() => parseSiteConfig(JSON.stringify(config)), /db\.prefix/, prefix);
    assert.throws(() => planUploads({ version, config, manifest, files }), /db\.prefix/, prefix);
    for (const pinned of [false, true]) {
      let calls = 0;
      await assert.rejects(loadGalleryDb({
        config: { ...config, db: { ...config.db, ...(pinned ? { release: manifest.db } : {}) } },
        fetchImpl: async () => { calls++; return Response.json(manifest); },
      }), /db\.prefix/, prefix);
      assert.equal(calls, 0, prefix);
    }
  }
});
