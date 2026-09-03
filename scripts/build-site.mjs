#!/usr/bin/env node
// build:site —— astro build（每话一 HTML，文字层内嵌）+ 平台生成物 + GitHub Pages 基线文件。
//
// 三平台的差异全在「构建完之后往 dist 里放什么」（ARCHITECTURE §3）：
//   · Cloudflare Pages 读 dist/_headers、dist/_redirects；
//   · EdgeOne 读 edgeone.json；
//   · GitHub Pages 什么都不读——.nojekyll、CNAME、404.html，重定向靠 meta refresh 页。
// 前两者受 features.platform_config 控制；关掉就是纯静态基线，站点必须照常可用（铁律 2）。
import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { GENERATED_FILES } from '@gallery/platform';
import { loadSiteConfig } from './lib/config.mjs';
import { DATA_DIR, DIST_DIR, PLATFORM_GENERATED_DIR, ROOT, SITE_DIR } from './lib/paths.mjs';
import { writeSiteConfigJson } from './lib/site-generated.mjs';
import { step, ok, note, warn } from './lib/log.mjs';

step('build:site');
const config = await loadSiteConfig();
await writeSiteConfigJson(config);
await rm(DIST_DIR, { recursive: true, force: true });

// 不经 npx，直接用 node 跑 astro 包自己声明的 bin：在 Actions / Codespaces / 任何本地环境
// 行为一致，也不依赖 PATH 里有没有 node_modules/.bin。
const require = createRequire(import.meta.url);
const astroPkgPath = require.resolve('astro/package.json');
const astro = join(dirname(astroPkgPath), require(astroPkgPath).bin.astro);
const r = spawnSync(process.execPath, [astro, 'build'], {
  cwd: SITE_DIR,
  stdio: 'inherit',
  env: { ...process.env, DATA_DIR },
});
if (r.status !== 0) process.exit(r.status ?? 1);

if (config.features.platform_config) {
  for (const f of GENERATED_FILES) {
    const src = join(PLATFORM_GENERATED_DIR, f);
    if (!existsSync(src)) {
      warn(`${relative(ROOT, src)} 不存在——先跑 npm run build:config`);
      process.exit(1);
    }
    await cp(src, join(DIST_DIR, f));
    ok(`dist/${f}`);
  }
} else {
  note('features.platform_config 关：不放平台配置生成物，dist 即纯静态基线');
}

// GitHub Pages 基线
await writeFile(join(DIST_DIR, '.nojekyll'), '');
ok('dist/.nojekyll');
if (config.deploy.github.cname) {
  await writeFile(join(DIST_DIR, 'CNAME'), `${config.site.domain}\n`);
  ok('dist/CNAME');
}
for (const rd of config.redirects) {
  // 只在目标路径还没有页面时才写兜底页：真页面永远优先于跳转页
  const dir = join(DIST_DIR, rd.from);
  const file = join(dir, 'index.html');
  if (existsSync(file)) continue;
  await mkdir(dir, { recursive: true });
  await writeFile(file, metaRefresh(rd.to));
  ok(`dist${rd.from}/index.html（meta refresh → ${rd.to}）`);
}

function metaRefresh(to) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="${config.site.lang}"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${esc(to)}"><link rel="canonical" href="${esc(to)}"><title>跳转中</title></head><body><a href="${esc(to)}">${esc(to)}</a></body></html>\n`;
}
