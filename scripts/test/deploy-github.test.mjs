// deploy:github 的端到端：临时 dist 目录，真 spawn 脚本，通过与不通过两种。
//
// GitHub Pages 是三平台的最小公分母（铁律 2）：没有响应头、没有重定向、没有函数。
// CNB 流水线把 dist 推到 GITHUB_PAGES_REPO 的 gh-pages 分支；这里用 DEPLOY_DRY_RUN=1
// 只走基线校验，把「dist 拿去就能当一个完整站点」这件事守住：.nojekyll、404.html、
// index.html 齐全，CNAME 等于 site.domain。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadSiteConfig } from '../lib/config.mjs';
import { releaseFingerprint } from '../lib/release.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'deploy.mjs');
const config = await loadSiteConfig();
config.site.domain = 'gallery.unit-fixture.org';
config.images.hosts = ['images.unit-fixture.org'];
const configDir = await mkdtemp(join(tmpdir(), 'gallery-github-config-'));
const configFile = join(configDir, 'site.config.yaml');
await writeFile(configFile, yaml.dump(config));
after(() => rm(configDir, { recursive: true, force: true }));

function run(env) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(GITHUB_PAGES_|DEPLOY_|DIST_DIR$|OUT_DIR$|RELEASE_VERSION$|CONFIG_FILE$)/.test(key)) delete clean[key];
  const r = spawnSync(process.execPath, [SCRIPT, 'github'], { cwd: ROOT, encoding: 'utf8', env: { ...clean, CONFIG_FILE: configFile, ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** 一个 dist：files 是文件名 → 内容；null 表示不建这个文件。 */
async function dist(t, files) {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-github-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'dist');
  await mkdir(join(dir, 'sample', 'vol01', 'c001'), { recursive: true });
  await writeFile(join(dir, 'sample', 'vol01', 'c001', 'index.html'), '<!doctype html>');
  for (const [name, content] of Object.entries(files)) if (content != null) await writeFile(join(dir, name), content);
  return dir;
}

const GOOD = { '.nojekyll': '', '404.html': '<!doctype html><title>404</title>', 'index.html': '<!doctype html><title>首页</title>', CNAME: `${config.site.domain}\n` };

test('deploy:github：基线文件齐全、CNAME 等于 site.domain + DEPLOY_DRY_RUN=1 → 退 0，只校验不上传', async (t) => {
  const r = run({ DIST_DIR: await dist(t, GOOD), DEPLOY_DRY_RUN: '1' });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(`基线文件齐全：.nojekyll、404.html、index.html、CNAME=${config.site.domain}`));
  assert.match(r.out, /DEPLOY_DRY_RUN=1：只校验基线，不推 gh-pages/);
});

test('deploy:github：基线齐全但没给 GITHUB_PAGES_REPO / GITHUB_PAGES_TOKEN → 退 1 并点名', async (t) => {
  const r = run({ DIST_DIR: await dist(t, GOOD) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /缺 GITHUB_PAGES_REPO \/ GITHUB_PAGES_TOKEN/);
  assert.match(r.out, /只校验基线用 DEPLOY_DRY_RUN=1/);
});

test('deploy:github：缺 404.html 与 .nojekyll → 退 1，逐条点名，其余照常', async (t) => {
  const r = run({ DIST_DIR: await dist(t, { ...GOOD, '404.html': null, '.nojekyll': null }) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✘ dist\/\.nojekyll 不存在/);
  assert.match(r.out, /✘ dist\/404\.html 不存在/);
  assert.doesNotMatch(r.out, /index\.html 不存在/);
  assert.doesNotMatch(r.out, /CNAME/);
});

test('deploy:github：CNAME 写错域名 → 退 1；index.html 是空文件 → 退 1', async (t) => {
  const wrong = run({ DIST_DIR: await dist(t, { ...GOOD, CNAME: 'wrong.example.org\n' }) });
  assert.equal(wrong.status, 1, wrong.out);
  assert.ok(wrong.out.includes(`dist/CNAME 内容是 "wrong.example.org"，应等于 site.domain（${config.site.domain}）`));

  const empty = run({ DIST_DIR: await dist(t, { ...GOOD, 'index.html': '' }) });
  assert.equal(empty.status, 1, empty.out);
  assert.match(empty.out, /dist\/index\.html 是空文件/);
});

test('deploy:github：预览目标在任何上传前拒绝；生产缺少发布清单也不能推送', async (t) => {
  const dir = await dist(t, GOOD);
  const outDir = join(dir, '..', 'out');
  const preview = run({ DIST_DIR: dir, OUT_DIR: outDir, DEPLOY_ENV: 'preview', DEPLOY_DRY_RUN: '1' });
  assert.equal(preview.status, 1, preview.out);
  assert.match(preview.out, /尚未配置独立预览目标/);
  const missing = run({ DIST_DIR: dir, OUT_DIR: outDir, GITHUB_PAGES_REPO: 'fixture/fixture', GITHUB_PAGES_TOKEN: 'fixture-token' });
  assert.equal(missing.status, 1, missing.out);
  assert.match(missing.out, /缺少本次完整构建的发布清单/);
  assert.doesNotMatch(missing.out, /fixture-token/);
  const manifest = { version: 'preview-test', db: { key: 'db/gallery-preview-test.sqlite' } };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'release.json'), JSON.stringify({ version: manifest.version, fingerprint: releaseFingerprint(manifest), environment: 'preview' }));
  const previewArtifact = run({ DIST_DIR: dir, OUT_DIR: outDir, GITHUB_PAGES_REPO: 'fixture/fixture', GITHUB_PAGES_TOKEN: 'fixture-token' });
  assert.equal(previewArtifact.status, 1, previewArtifact.out);
  assert.match(previewArtifact.out, /dist 与发布清单|环境/);
  assert.doesNotMatch(previewArtifact.out, /fixture-token/);
});

test('deploy:github：dist 不存在 → 退 1 并提示先 build，不打栈', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-github-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const r = run({ DIST_DIR: join(tmp, 'nope') });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /不存在：先 npm run build/);
  assert.doesNotMatch(r.out, /\n\s+at /);
});
