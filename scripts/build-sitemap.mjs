#!/usr/bin/env node
// build:sitemap —— dist/sitemap.xml（超过 45 000 条时拆成 sitemap index + sitemap-<n>.xml）、dist/robots.txt，
// 以及 seo.indexnow_key 非空时的 dist/<key>.txt。
//
// 三样都含站点域名或配置里的值，所以由脚本从 site.config.yaml 生成而不是放 packages/site/public/——
// 域名只在配置里出现一次（铁律 5）。URL 清单、分片、robots、key 文件的逻辑全在 scripts/lib/sitemap.mjs，
// 与推送脚本、check 守卫共用同一份「站点有哪些 URL」的答案；这里只做接线与打印。
//
// URL 覆盖首页、/search/、每个作品 / 期 / 话；期的 published 有则作为该期与其各话的 <lastmod>。
// 单个 sitemap 上限是 50 000 条 / 50 MB，文件数预算（§2）把话压在 18 000 以内，日常是单文件；
// 拆分逻辑照样在，预算放宽那天不用再回来改。
//
// IndexNow key 文件：协议要求 https://<domain>/<key>.txt 的内容与 key 逐字相同、按字节比对，所以末尾不带换行。
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { loadGallery } from './lib/data.mjs';
import { DATA_DIR, DIST_DIR, ROOT } from './lib/paths.mjs';
import { siteUrls, renderSitemaps, renderRobots, writeIndexNowKeyFile, SITEMAP_MAX_PER_FILE, SITEMAP_SHARD_RE } from './lib/sitemap.mjs';
import { step, ok, note } from './lib/log.mjs';

// 仓库内的路径显示成相对形式；DIST_DIR 被环境变量指到仓库外（测试、CI 临时目录）时原样打印
const show = (p) => (p.startsWith(ROOT + sep) ? relative(ROOT, p).split(sep).join('/') : p);

step('build:sitemap');
const config = await loadSiteConfig();
const gallery = await loadGallery({ dataDir: DATA_DIR, imagePrefix: config.images.prefix });
const origin = `https://${config.site.domain}`;

const entries = siteUrls(gallery, origin);
// index 里的 <lastmod> 用生成日（UTC）；日期在这里取、不在纯函数里取
const today = new Date().toISOString().slice(0, 10);
const files = renderSitemaps(entries, { origin, today });

await mkdir(DIST_DIR, { recursive: true });
// 上一次生成的分片若这次用不上就删掉：站点变小、从 index 退回单文件时，残留的 sitemap-<n>.xml
// 虽然没人指向它，仍是一份过期的 URL 清单，搜索引擎顺着旧地址照样能抓到
const keep = new Set(files.map((f) => f.name));
for (const name of await readdir(DIST_DIR)) {
  if (SITEMAP_SHARD_RE.test(name) && !keep.has(name)) {
    await rm(join(DIST_DIR, name));
    note(`删掉过期分片 ${name}`);
  }
}
for (const f of files) {
  await writeFile(join(DIST_DIR, f.name), f.xml);
  ok(show(join(DIST_DIR, f.name)));
}
if (files.length > 1) note(`${entries.length} 条 URL 超过单文件 ${SITEMAP_MAX_PER_FILE} 条，拆成 index + ${files.length - 1} 个分片`);

const robotsFile = join(DIST_DIR, 'robots.txt');
await writeFile(robotsFile, renderRobots(origin));
ok(show(robotsFile));

const keyFile = await writeIndexNowKeyFile(config, DIST_DIR);
if (keyFile) ok(`${show(keyFile)}（IndexNow key 文件：内容即 key，末尾无换行）`);
else note('seo.indexnow_key 为空：不写 IndexNow key 文件，push:search 也不会推 IndexNow');

ok(`build:sitemap：写了 ${files.length + 1 + (keyFile ? 1 : 0)} 个文件、${entries.length} 条 URL；IndexNow key 文件${keyFile ? '已写' : '未写'}`);
note(`域名 ${config.site.domain}；话 ${gallery.totals.chapters}、期 ${gallery.totals.issues}、作品 ${gallery.totals.series}`);
