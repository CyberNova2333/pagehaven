#!/usr/bin/env node
// publish:r2 —— 把本次发布的产物放进对象存储：检索库与分块摘要、dist 归档、新图片，最后换 manifest 指针。
//
// 只在发布流水线里真跑（铁律 7：写凭据只在 CI 的 secrets 里）。本地与检查流水线没有凭据——
// 但这里不像 build:manifest 那样「跳过并继续」：publish 的语义就是上传，没凭据就是流水线配错了，
// 静默成功会让人以为发出去了。想看会传什么而不真传，用 PUBLISH_DRY_RUN=1。
//
// 计划（key / Content-Type / Cache-Control / 顺序）在 scripts/lib/publish-plan.mjs，这里只做接线：
//   1. 读配置、版本、out/manifest.json，列 out/db 与 IMAGES_DIR，算计划并打印；
//   2. 预检 dist 存在、tar 与 zstd 可用、（非 dry-run）凭据齐全——一次列全，dry-run 也做前两项：
//      dry-run 是给没凭据的环境看「真跑会不会成」的，对一个必败的环境说 OK 就没意义了；
//   3. 先把线上现有的 manifest.json 原样存成 OUT_DIR/manifest-previous.json：push:search 靠它与新 manifest
//      的差集只推本次新增的页面，而第 7 步会把它覆盖掉，这是唯一还能拿到它的时机。放在任何上传之前，
//      读到的一定是上一版。不存在 = 首次发布，提示后继续；读不到（非 404）就停——不知道线上是哪一版，
//      就不该去换指针。dry-run 不读；
//   4. dist 打成 site-<v>.tar.zst（tar --zstd；归档格式是文档约定，tar 或 zstd 不可用就报错，不换 gzip）；
//   5. 传库与分块摘要、传归档、传新图片（先 head，已存在就跳过——内容哈希 key，字节一定相同）；
//   6. head 核对 manifest 引用的每个图片 key 都在存储里（并发 8），缺的逐条列出并非零退出；
//   7. 都在位了才传 manifest.json：它是「当前版本指针」，中途失败时线上仍指向上一版。
//
// IMAGES_DIR：新图片的来源目录，里面按 manifest.imageKeys 去掉 images.prefix 后的相对路径放文件
// （img/<series>/<issue>/<chapter>/<n>-<hash12>.avif → <IMAGES_DIR>/<series>/<issue>/<chapter>/<n>-<hash12>.avif）。
// 没给就不传图，只核对——图早已在存储里的日常重建就是这种情况。目录里的符号链接会被解引用：
// 在 CI / Codespaces 里用 ln -s 把图片目录挂进来很自然，跳过它们只会得到一句误导的「缺 key」。
import { spawnSync } from 'node:child_process';
import { readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { readManifest, resolveVersion, MANIFEST_FILE } from './lib/manifest.mjs';
import { planUploads, archiveFileName, dbFileNames } from './lib/publish-plan.mjs';
import { MANIFEST_PREVIOUS_FILE } from './lib/seo-push.mjs';
import { r2ClientFromEnv, R2_ENV_KEYS, getObjectText, headObject, putObject } from './lib/r2.mjs';
import { DIST_DIR, OUT_DIR, OUT_DB_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, fail, note, warn } from './lib/log.mjs';

const HEAD_CONCURRENCY = 8;
const UPLOAD_CONCURRENCY = 4;

// 仓库内的路径显示成相对形式；被环境变量指到仓库外（测试、CI 临时目录）时原样打印
const show = (p) => (p.startsWith(ROOT + sep) ? relative(ROOT, p).split(sep).join('/') : p);
/** 预期中的配置错误：说清楚就退，不打栈——栈只会把手机上的日志推出屏幕。 */
const bail = (msg) => {
  fail(msg);
  process.exit(1);
};

/**
 * 递归列目录，返回相对 dir 的 posix 路径，排序。符号链接按指向的东西算（目录就进去，文件就收）；
 * 同一个真实目录只进一次——既然跟着链接走，就得防链接指回祖先目录时转圈。
 */
async function walkRelative(dir, base = dir, out = [], seen = new Set()) {
  const real = await realpath(dir);
  if (seen.has(real)) return out;
  seen.add(real);
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    if (ent.isSymbolicLink()) {
      let s;
      try {
        s = await stat(p);
      } catch (e) {
        if (e.code === 'ENOENT') bail(`IMAGES_DIR 里的符号链接指向不存在的目标：${relative(base, p).split(sep).join('/')}`);
        throw e;
      }
      isDir = s.isDirectory();
      isFile = s.isFile();
    }
    if (isDir) await walkRelative(p, base, out, seen);
    else if (isFile) out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

/** 有限并发地跑 fn；任何一个抛错整体抛（存储报错要让人看到，不是吞掉继续）。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * 归档工具的预检：只跑 --version，无副作用。缺哪个就说哪个，别等打包到一半才发现。
 * @returns {string} 版本行（进日志，CI 上一眼看到用的是哪个 tar / zstd）
 */
function toolVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`${bin} 不可用（${r.error?.code ?? `退出码 ${r.status}`}）：dist 归档格式 tar.zst 是文档约定（ARCHITECTURE §5、§8），不换 gzip；ubuntu runner 与 Codespaces 里 apt 自带 zstd`);
  }
  return (r.stdout || '').split('\n')[0].trim() || `${bin}（无版本输出）`;
}

function createArchive(distDir, archivePath) {
  // -C dist . ：归档里是站点根的相对路径，解开就是一份能直接托管的 dist
  const r = spawnSync('tar', ['--zstd', '-cf', archivePath, '-C', distDir, '.'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) throw new Error(`tar 启动失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar --zstd 退出码 ${r.status}，归档失败`);
}

step('publish:r2');
const t0 = performance.now();
const dryRun = process.env.PUBLISH_DRY_RUN === '1';
try {
  const config = await loadSiteConfig();
  const version = resolveVersion();
  const manifest = await readManifest(OUT_DIR);
  if (!manifest) bail(`${show(join(OUT_DIR, MANIFEST_FILE))} 不存在：先 npm run build`);

  const dbFiles = existsSync(OUT_DB_DIR) ? (await readdir(OUT_DB_DIR)).sort().map((f) => join(OUT_DB_DIR, f)) : [];
  // 库的实际字节数交给计划与 manifest.db.size 比：manifest 与库来自不同次构建时，名字对得上、大小对不上
  const dbPath = dbFiles.find((f) => basename(f) === dbFileNames(version).db);
  const dbSize = dbPath ? (await stat(dbPath)).size : undefined;
  const archivePath = join(OUT_DIR, archiveFileName(version));
  const imagesDir = process.env.IMAGES_DIR ? resolve(process.env.IMAGES_DIR) : null;
  if (imagesDir && !(existsSync(imagesDir) && (await stat(imagesDir)).isDirectory())) bail(`IMAGES_DIR=${imagesDir} 不是目录`);
  const images = imagesDir ? await walkRelative(imagesDir) : null;

  const plan = planUploads({
    version,
    config,
    manifest,
    files: { db: dbFiles, dbSize, manifest: join(OUT_DIR, MANIFEST_FILE), distArchive: archivePath, images },
  });

  note(`版本 ${version}；manifest 引用 ${plan.verifyKeys.length} 个图片 key`);
  for (const u of plan.uploads) {
    const src = u.kind === 'image' ? join(imagesDir, u.path) : u.path;
    note(`${u.key}  ←  ${show(src)}  [${u.contentType}; ${u.cacheControl}${u.skipIfExists ? '; 已存在则跳过' : ''}]`);
  }
  if (!imagesDir) {
    note('IMAGES_DIR 未设置：不上传新图片，只核对 manifest 引用的图片都已在存储里');
  } else {
    note(`${show(imagesDir)}：${plan.images.uploads} 个待传（已存在会跳过）`);
    if (plan.images.ignored.length) note(`${plan.images.ignored.length} 个文件 manifest 没引用，不传：${plan.images.ignored.slice(0, 5).join(', ')}${plan.images.ignored.length > 5 ? ' …' : ''}`);
    if (plan.images.unsupported.length) warn(`${plan.images.unsupported.length} 个文件扩展名不是 avif/webp，不传：${plan.images.unsupported.join(', ')}`);
  }

  // 预检一次列全：一次跑就把配置错误全看到，而不是修一个再撞下一个
  const problems = [];
  if (!existsSync(DIST_DIR)) problems.push(`${show(DIST_DIR)} 不存在：先 npm run build`);
  const tools = {};
  for (const bin of ['tar', 'zstd']) {
    try {
      tools[bin] = toolVersion(bin);
    } catch (e) {
      problems.push(e.message);
    }
  }
  const r2 = dryRun ? null : r2ClientFromEnv();
  if (!dryRun && !r2) problems.push(`没有对象存储写凭据（${R2_ENV_KEYS.join(' / ')} 缺任一个）：发布流程里缺凭据是配置错误，不能静默成功；只想看计划用 PUBLISH_DRY_RUN=1`);
  if (problems.length) {
    for (const p of problems) fail(p);
    process.exit(1);
  }
  note(`归档工具可用：${tools.tar}；${tools.zstd}`);
  if (dryRun) {
    ok(`PUBLISH_DRY_RUN=1：只打印计划，${plan.uploads.length} 个对象未上传，归档未生成`);
    process.exit(0);
  }

  const { client, bucket } = r2;
  const manifestUpload = plan.uploads.find((u) => u.kind === 'manifest');
  const bulk = plan.uploads.filter((u) => u.kind !== 'manifest' && u.kind !== 'image');
  const imageUploads = plan.uploads.filter((u) => u.kind === 'image');

  // 存线上旧 manifest（文件头第 3 步）：在归档与任何上传之前，读到的一定是上一版；读失败带上下文再抛，
  // 外层会连 HTTP 状态一起打出来并退 1
  const previousFile = join(OUT_DIR, MANIFEST_PREVIOUS_FILE);
  let previousText;
  try {
    previousText = await getObjectText(client, bucket, manifestUpload.key);
  } catch (e) {
    e.message = `读线上旧 ${manifestUpload.key} 失败，不知道线上是哪一版就不能换指针：${e.message}`;
    throw e;
  }
  if (previousText == null) {
    // 上次跑剩下的旧文件不能留着：它会让 push:search 拿一份不相干的基线算差集
    await rm(previousFile, { force: true });
    note(`存储里没有 ${manifestUpload.key}：首次发布，不写 ${show(previousFile)}（push:search 会推全部页面）`);
  } else {
    await writeFile(previousFile, previousText);
    let previousVersion = '?';
    try {
      previousVersion = JSON.parse(previousText).version ?? '?';
    } catch {
      warn(`线上旧 ${manifestUpload.key} 不是合法 JSON，仍原样存下（push:search 会报它）`);
    }
    ok(`线上旧 manifest（版本 ${previousVersion}）已存为 ${show(previousFile)}（push:search 据此只推新页面）`);
  }

  // 先归档：打包失败时一个字节都还没传，不留下半份发布
  const tArchive = performance.now();
  createArchive(DIST_DIR, archivePath);
  ok(`${show(archivePath)}：${(await stat(archivePath)).size} 字节，${Math.round(performance.now() - tArchive)} ms`);

  const put = async (u) => {
    const src = u.kind === 'image' ? join(imagesDir, u.path) : u.path;
    const body = await readFile(src);
    await putObject(client, bucket, u.key, body, { contentType: u.contentType, cacheControl: u.cacheControl });
    return body.length;
  };

  for (const u of bulk) {
    const size = await put(u);
    ok(`${u.key}：${size} 字节`);
  }

  let skipped = 0;
  let uploaded = 0;
  await mapLimit(imageUploads, UPLOAD_CONCURRENCY, async (u) => {
    if (await headObject(client, bucket, u.key)) {
      skipped += 1;
      return;
    }
    await put(u);
    uploaded += 1;
  });
  if (imageUploads.length) ok(`图片：新传 ${uploaded} 个，已存在跳过 ${skipped} 个`);

  const tVerify = performance.now();
  const missing = (await mapLimit(plan.verifyKeys, HEAD_CONCURRENCY, async (key) => ((await headObject(client, bucket, key)) ? null : key))).filter(Boolean);
  if (missing.length) {
    fail(`manifest 引用了 ${missing.length} 个对象存储里不存在的图片 key（manifest.json 未更新，线上仍指向上一版；把图放进 IMAGES_DIR 再发布）：`);
    for (const k of missing) note(`缺 ${k}`);
    process.exit(1);
  }
  ok(`核对通过：manifest 引用的 ${plan.verifyKeys.length} 个图片 key 全部存在，${Math.round(performance.now() - tVerify)} ms`);

  const size = await put(manifestUpload);
  ok(`${manifestUpload.key}：${size} 字节（当前版本指针已指向 ${manifest.db.key}）`);
  ok(`publish:r2 完成，共 ${Math.round(performance.now() - t0)} ms`);
} catch (e) {
  // 计划 / 数据问题的信息本身已逐条列好（e.issues），再打栈只会把手机上的日志推出屏幕。
  // 存储的错误把 HTTP 状态码带上：SDK 对 HEAD 的非 404 错误只给一个 name，状态码才是定位的线索
  const status = e?.$metadata?.httpStatusCode;
  fail(status ? `对象存储回 HTTP ${status}（${e.name}）：${e.message}（manifest.json 未更新，线上仍指向上一版）` : e.message);
  if (!e.issues) console.error(e.stack);
  process.exit(1);
}
