// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadSiteConfig } from '../lib/config.mjs';
import { ROOT } from '../lib/paths.mjs';
import { resolvePnpmCommand } from '../lib/pnpm-runner.mjs';
import { R2_ENV_KEYS } from '../lib/r2.mjs';
import { releaseFingerprint } from '../lib/release.mjs';

test('同一检出同时构建空站和样本站，各自绑定配置、台词、检索库和发布指纹', { timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pagehaven-builds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { command, args } = resolvePnpmCommand(['run', 'build']);
  async function build(name, data, count) {
    const work = join(dir, name);
    await mkdir(work);
    const config = await loadSiteConfig();
    config.site.title = name;
    config.site.domain = name + '.example.org';
    config.features.text_layer = true;
    const env = { ...process.env, BUILD_WORK_DIR: work, CONFIG_FILE: join(work, 'site.yaml'),
      DATA_DIR: data, RELEASE_VERSION: name, DEPLOY_ENV: 'production' };
    for (const key of ['OUT_DIR', 'DIST_DIR', ...R2_ENV_KEYS]) delete env[key];
    const dist = join(work, count ? 'custom-dist' : 'dist');
    if (count) env.DIST_DIR = dist;
    await writeFile(env.CONFIG_FILE, JSON.stringify(config));
    await promisify(execFile)(command, args, { cwd: ROOT, env });
    const json = async (path) => JSON.parse(await readFile(join(work, path), 'utf8'));
    const gallery = await json('site-generated/gallery.json');
    const manifest = await json('out/manifest.json');
    const release = JSON.parse(await readFile(join(dist, 'release.json'), 'utf8'));
    const html = await readFile(join(dist, 'search/index.html'), 'utf8');
    const search = JSON.parse(/id="search-config">(.+?)<\/script>/.exec(html)[1]);
    assert.equal(gallery.totals.chapters, count);
    assert.equal(release.version, name);
    assert.equal(release.fingerprint, releaseFingerprint(manifest));
    assert.equal(manifest.site.domain, config.site.domain);
    assert.deepEqual(search.db.release, manifest.db);
    assert.deepEqual(gallery.searchDb, manifest.db);
    assert.ok(html.includes('<meta property="og:site_name" content="' + name + '">'));
    assert.equal((await json('site-generated/site-config.json')).site.title, name);
    assert.equal(existsSync(join(work, 'site-generated/text/beacon/v1/signal.json')), count > 0);
    if (count) assert.match(await readFile(join(dist, 'beacon/v1/signal/index.html'), 'utf8'), /今晚，灯塔会亮吗/);
    for (const target of ['wrangler.jsonc', 'esa.jsonc']) {
      const template = await json('platform-generated/' + target);
      assert.equal(resolve(work, 'platform-generated', template.assets.directory), dist);
    }
  }
  const results = await Promise.allSettled([build('empty', join(dir, 'empty-data'), 0),
    build('sample', join(ROOT, 'scripts/demo/data'), 1)]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});
