#!/usr/bin/env node
// build:sitemap —— dist/sitemap.xml 与 dist/robots.txt。
//
// 两者都含站点域名，所以由脚本从 site.config.yaml 生成而不是放 packages/site/public/——
// 域名只在配置里出现一次（铁律 5）。URL 覆盖首页、/search/、每个作品 / 期 / 话；
// 期的 published 有则作为该期与其各话的 <lastmod>（话没有自己的日期，随所属期）。
// 单个 sitemap 上限是 50 000 条 URL / 50 MB：文件数预算（§2）把话压在 18 000 以内，够用；
// 真到那一天再拆 sitemap index。
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { loadGallery } from './lib/data.mjs';
import { DATA_DIR, DIST_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, note } from './lib/log.mjs';

step('build:sitemap');
const config = await loadSiteConfig();
const gallery = await loadGallery({ dataDir: DATA_DIR, imagePrefix: config.images.prefix });
const origin = `https://${config.site.domain}`;

/** @type {Array<{loc: string, lastmod?: string}>} */
const entries = [{ loc: '/' }, { loc: '/search/' }];
for (const s of gallery.series) {
  entries.push({ loc: s.url });
  for (const iss of s.issues) {
    entries.push({ loc: iss.url, lastmod: iss.published });
    for (const c of iss.chapters) entries.push({ loc: c.url, lastmod: iss.published });
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...entries.map((e) => `  <url><loc>${esc(origin + e.loc)}</loc>${e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : ''}</url>`),
  '</urlset>',
  '',
].join('\n');

await mkdir(DIST_DIR, { recursive: true });
const sitemapFile = join(DIST_DIR, 'sitemap.xml');
await writeFile(sitemapFile, xml);
ok(`${relative(ROOT, sitemapFile)}（${entries.length} 条 URL）`);

const robotsFile = join(DIST_DIR, 'robots.txt');
await writeFile(robotsFile, `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
ok(relative(ROOT, robotsFile));
note(`域名 ${config.site.domain}；话 ${gallery.totals.chapters}、期 ${gallery.totals.issues}、作品 ${gallery.totals.series}`);
