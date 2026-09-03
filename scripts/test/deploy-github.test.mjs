// deploy:github 的端到端：临时 dist 目录，真 spawn 脚本，通过与不通过两种。
//
// GitHub Pages 是三平台的最小公分母（铁律 2）：没有响应头、没有重定向、没有函数。脚本不上传
// （release.yml 用 upload-pages-artifact + deploy-pages），只把「dist 拿去就能当一个完整站点」
// 这件事守住：.nojekyll、404.html、index.html 齐全，CNAME 等于 site.domain。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from '../lib/config.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'deploy.mjs');
const config = await loadSiteConfig();

function run(env) {
  const r = spawnSync(process.execPath, [SCRIPT, 'github'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
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

test('deploy:github：基线文件齐全、CNAME 等于 site.domain → 退 0', async (t) => {
  const r = run({ DIST_DIR: await dist(t, GOOD) });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /基线文件齐全：\.nojekyll、404\.html、index\.html、CNAME=gallery\.example\.org/);
  assert.match(r.out, /上传由 workflow 的 deploy-pages 完成/);
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
  assert.match(wrong.out, /dist\/CNAME 内容是 "wrong\.example\.org"，应等于 site\.domain（gallery\.example\.org）/);

  const empty = run({ DIST_DIR: await dist(t, { ...GOOD, 'index.html': '' }) });
  assert.equal(empty.status, 1, empty.out);
  assert.match(empty.out, /dist\/index\.html 是空文件/);
});

test('deploy:github：dist 不存在 → 退 1 并提示先 build，不打栈', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'gallery-deploy-github-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const r = run({ DIST_DIR: join(tmp, 'nope') });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /不存在：先 npm run build/);
  assert.doesNotMatch(r.out, /\n\s+at /);
});
