#!/usr/bin/env node
// build:index —— 元数据检索用的索引分片（ARCHITECTURE §6「元数据检索」：纯前端过滤 JSON）。
//
//   dist/index/series.json     作品总表：[{ id, title, url, issues: 期数, chapters: 话数 }]
//   dist/index/<series>.json   一个作品的期 / 话：{ id, title, issues: [{ id, number, title, published,
//                              url, chapters: [{ id, number, title, url, key, pages: 页数, hasText }] }] }
//
// 按作品分片而不是一话一个：文件数预算（§2）与单次下载量都可控——前端先取总表，选了作品再取
// 那一片。分片里不放页的图片 key 与台词，那是阅读器与检索库的事。
// published 没有时写 null 而不是省略：前端按固定形状读，不用逐条判断 key 在不在。
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { loadGallery } from './lib/data.mjs';
import { assertNoReservedIds } from './lib/site-generated.mjs';
import { DATA_DIR, DIST_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, note } from './lib/log.mjs';

step('build:index');
const config = await loadSiteConfig();
const gallery = await loadGallery({ dataDir: DATA_DIR, imagePrefix: config.images.prefix });
// 作品 id 叫 series 会盖掉总表 series.json——与站点路由的保留字一起在这里拦
assertNoReservedIds(gallery);

const dir = join(DIST_DIR, 'index');
await mkdir(dir, { recursive: true });

const summary = gallery.series.map((s) => ({
  id: s.id,
  title: s.title,
  url: s.url,
  issues: s.issues.length,
  chapters: s.issues.reduce((n, iss) => n + iss.chapters.length, 0),
}));
await writeFile(join(dir, 'series.json'), JSON.stringify(summary) + '\n');
ok(`${relative(ROOT, join(dir, 'series.json'))}（${summary.length} 个作品）`);

for (const s of gallery.series) {
  const shard = {
    id: s.id,
    title: s.title,
    issues: s.issues.map((iss) => ({
      id: iss.id,
      number: iss.number,
      title: iss.title,
      published: iss.published ?? null,
      url: iss.url,
      chapters: iss.chapters.map((c) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        url: c.url,
        key: c.key,
        pages: c.pages.length,
        hasText: c.hasText,
      })),
    })),
  };
  const file = join(dir, `${s.id}.json`);
  await writeFile(file, JSON.stringify(shard) + '\n');
  note(`${relative(ROOT, file)}：${shard.issues.length} 期`);
}
ok(`build:index：${gallery.series.length} 片`);
