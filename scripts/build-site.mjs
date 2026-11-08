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
import { loadGallery } from './lib/data.mjs';
import { readManifest, galleryFingerprint } from './lib/manifest.mjs';
import { releaseFingerprint } from './lib/release.mjs';
import { DATA_DIR, DIST_DIR, OUT_DIR, PLATFORM_GENERATED_DIR, ROOT, SITE_DIR } from './lib/paths.mjs';
import { writeSiteConfigJson, writeSiteGalleryJson } from './lib/site-generated.mjs';
import { metaRefresh, redirectOutputPaths } from './lib/static-output.mjs';
import { step, ok, note, warn } from './lib/log.mjs';

step('build:site');
const config = await loadSiteConfig();
const redirects = config.redirects.map((rd) => ({ ...rd, ...redirectOutputPaths(DIST_DIR, rd.from) }));
await writeSiteConfigJson(config, { preview: process.env.DEPLOY_ENV === 'preview' });
// 数据进站点的唯一通道：模型写成 src/generated/ 下的 JSON，页面用 import / import.meta.glob 读。
// 0 话时也照建——gallery.json 是空树、text/ 是空目录，动态路由生成不出页面，其余页面照常。
const gallery = await loadGallery({ dataDir: DATA_DIR, imagePrefix: config.images.prefix });
const manifest = await readManifest(OUT_DIR);
if (manifest?.db && (manifest.sourceSha256 !== galleryFingerprint(gallery) || manifest.site.domain !== config.site.domain ||
    (process.env.RELEASE_VERSION && manifest.version !== process.env.RELEASE_VERSION))) {
  throw new Error('站点数据与检索库构建清单不一致，请重新运行完整 build');
}
const generated = await writeSiteGalleryJson(gallery, { searchDb: manifest?.db ?? null });
note(`${relative(ROOT, generated.galleryFile)}：${gallery.totals.series} 个作品、${gallery.totals.chapters} 话；台词分片 ${generated.textFiles.length} 份`);
await rm(DIST_DIR, { recursive: true, force: true });

// 不经 npx，直接用 node 跑 astro 包自己声明的 bin：在 CNB / Codespaces / 任何本地环境
// 行为一致，也不依赖 PATH 里有没有 node_modules/.bin。
const require = createRequire(import.meta.url);
const astroPkgPath = require.resolve('astro/package.json');
const astro = join(dirname(astroPkgPath), require(astroPkgPath).bin.astro);
const r = spawnSync(process.execPath, [astro, 'build', '--outDir', DIST_DIR], {
  cwd: SITE_DIR,
  stdio: 'inherit',
  env: { ...process.env, DATA_DIR },
});
if (r.status !== 0) process.exit(r.status ?? 1);

if (manifest?.db) {
  await writeFile(join(DIST_DIR, 'release.json'), JSON.stringify({
    version: manifest.version, fingerprint: releaseFingerprint(manifest), environment: process.env.DEPLOY_ENV || 'production',
  }) + '\n');
}

if (config.features.platform_config) {
  for (const f of GENERATED_FILES) {
    const src = join(PLATFORM_GENERATED_DIR, f);
    if (!existsSync(src)) {
      warn(`${relative(ROOT, src)} 不存在——先跑 pnpm run build:config`);
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
for (const rd of redirects) {
  // 只在目标路径还没有页面时才写兜底页：真页面永远优先于跳转页
  const { dir, file } = rd;
  if (existsSync(file)) continue;
  await mkdir(dir, { recursive: true });
  await writeFile(file, metaRefresh(rd.to, config.site.lang));
  ok(`dist${rd.from}/index.html（meta refresh → ${rd.to}）`);
}
