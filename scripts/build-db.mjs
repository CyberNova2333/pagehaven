#!/usr/bin/env node
// build:db —— data/meta + data/text → out/db/gallery-<version>.sqlite（FTS5 trigram）+ .chunks.json
//
// 建库本身在 @gallery/core（纯 Web 标准，测试与函数版检索复用同一份），这里只做构建期的接线：
// 读配置与数据、定版本号、落盘、把当前版本写进 manifest.json 的 db 字段。
//
// 版本号进文件名（ARCHITECTURE §4「带版本的 key」）：对象存储上新旧两份并存，manifest 指到哪份
// 检索端就读哪份，切换时不存在「CDN 缓存里一半新一半旧」的窗口。版本号的规则（RELEASE_VERSION，
// 缺省 UTC 日期）与 build:manifest 共用 scripts/lib/manifest.mjs 的同一个函数，且这里会核对
// manifest.json 里已写的版本：两个脚本跨 UTC 零点、或单独重跑其一，都会让库文件名与 manifest
// 对不上，publish:r2 那时才拦就太晚——build 应当在这里就红。
//
// 同一版本号只能发布一次：带版本的 key 在 CDN 侧带一年 immutable 缓存，同名对象用不同字节覆盖，
// 检索端会拿到缓存里的旧块、逐块校验全部失败，直到缓存过期前检索整体不可用。所以同一天二次发布
// 必须换版本号（RELEASE_VERSION 带序号，如 <日期>.2），不能靠覆盖；这条由发布流程保证，本脚本
// 只负责把版本号忠实写进文件名。
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { buildGalleryDb, openGalleryDb, tableCounts } from '@gallery/core/db/build';
import { computeChunkManifest } from '@gallery/core/db/chunks';
import { loadSiteConfig } from './lib/config.mjs';
import { loadGallery } from './lib/data.mjs';
import { readManifest, resolveVersion, galleryFingerprint, MANIFEST_FILE } from './lib/manifest.mjs';
import { DATA_DIR, OUT_DIR, OUT_DB_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, fail, note } from './lib/log.mjs';

// 仓库内的路径显示成相对形式；OUT_DIR 被环境变量指到仓库外（测试、CI 临时目录）时原样打印
const show = (p) => (p.startsWith(ROOT + sep) ? relative(ROOT, p).split(sep).join('/') : p);

step('build:db');
const t0 = performance.now();
try {
  const config = await loadSiteConfig();
  const version = resolveVersion();
  const { page_size: pageSize, chunk_size: chunkSize, prefix } = config.db;

  // manifest.json 由 build:manifest 先写；先核对版本再动手，对不上就什么都不写
  const manifestPath = join(OUT_DIR, MANIFEST_FILE);
  const manifest = await readManifest(OUT_DIR);
  if (manifest && manifest.version !== version) {
    throw new Error(
      `${show(manifestPath)} 的版本是 ${JSON.stringify(manifest.version)}，本次 build:db 的版本是 ${version}：` +
        '库文件名会与 manifest 对不上。先重跑 pnpm run build:manifest，或给两个脚本统一的 RELEASE_VERSION',
    );
  }

  const gallery = await loadGallery({ dataDir: DATA_DIR, imagePrefix: config.images.prefix });
  if (manifest?.sourceSha256 && manifest.sourceSha256 !== galleryFingerprint(gallery)) {
    throw new Error('输入数据与 manifest 不一致，请重新运行 build:manifest');
  }
  const t = gallery.totals;
  note(`${show(DATA_DIR)}：${t.series} 个作品、${t.issues} 期、${t.chapters} 话、${t.pages} 页、${t.boxes} 个台词框`);
  if (t.chapters === 0) note('0 话：照建一份空库，检索页对着空库能正常回「无结果」');

  const tBuild = performance.now();
  const bytes = await buildGalleryDb(gallery, { pageSize });
  const buildMs = Math.round(performance.now() - tBuild);
  const chunks = await computeChunkManifest(bytes, chunkSize);

  // 落盘之前先把导出的字节原样开回来逐页校验、数行数：复验的是内存里的字节，不必先写文件；
  // 万一复验失败，out/db 里也不会留下一份 check 只看文件头就会放行的坏库
  const db = await openGalleryDb(bytes, { verify: true });
  let counts;
  try {
    counts = tableCounts(db);
  } finally {
    db.close();
  }

  const dbName = `gallery-${version}.sqlite`;
  const chunksName = `${dbName}.chunks.json`;
  // 清空再写：out/db 里只该有当前版本这一对文件，旧版本留着会被 publish:r2 一起传上去
  await rm(OUT_DB_DIR, { recursive: true, force: true });
  await mkdir(OUT_DB_DIR, { recursive: true });
  const dbPath = join(OUT_DB_DIR, dbName);
  const chunksPath = join(OUT_DB_DIR, chunksName);
  await writeFile(dbPath, bytes);
  await writeFile(chunksPath, JSON.stringify(chunks, null, 2) + '\n');

  ok(`${show(dbPath)}：${bytes.length} 字节 = ${bytes.length / pageSize} 页 × ${pageSize}，建库 ${buildMs} ms，逐页校验通过`);
  note(`行数：series ${counts.series}、issues ${counts.issues}、chapters ${counts.chapters}、pages ${counts.pages}、lines ${counts.lines}`);
  ok(`${show(chunksPath)}：${chunks.chunks.length} 块 × ${chunkSize}，整份 sha256 ${chunks.sha256.slice(0, 12)}…`);

  // 只更新 db 字段，其余原样保留（形状见 scripts/lib/manifest.mjs 的 Manifest.db）
  if (manifest) {
    manifest.db = {
      version,
      key: prefix + dbName,
      size: bytes.length,
      sha256: chunks.sha256,
      pageSize,
      chunkSize,
      chunks: prefix + chunksName,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    ok(`${show(manifestPath)}：db 字段指向 ${manifest.db.key}`);
  } else {
    note(`${show(manifestPath)} 不存在（build:manifest 尚未跑），跳过 db 字段更新`);
  }
  ok(`build:db 完成，共 ${Math.round(performance.now() - t0)} ms`);
} catch (e) {
  // 数据 / 配置问题的信息本身已逐条列好（e.issues），再打栈只会把手机上的日志推出屏幕
  fail(e.message);
  if (!e.issues) console.error(e.stack);
  process.exit(1);
}
