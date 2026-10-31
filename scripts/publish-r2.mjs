#!/usr/bin/env node
// publish:r2 —— 只上传本次版本的不可变资源，不读写生产 manifest.json。
//
// 库、分块摘要、归档与图片只允许「不存在时创建」；同内容重跑跳过，不同内容必须换版本号。
// 所有图片核对存在后，最后上传 db/manifest-<version>.json。站点部署与正式版本启用由后续步骤完成。
// manifest 重建时只忽略顶层 generatedAt 的差异，存储中的原文字节保持不动。
//
// PUBLISH_DRY_RUN=1 只打印计划并核对归档工具，不访问存储。IMAGES_DIR 可选；没给则只核对图片。
// 图片目录允许符号链接，并通过真实路径去重防止目录循环。归档使用固定排序、时间和所有者，
// 避免相同产物因为构建机器的文件元信息变化而误判为同版本不同内容。
import { spawnSync } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { resolveVersion, MANIFEST_FILE } from './lib/manifest.mjs';
import { planUploads, archiveFileName, dbFileNames, sameReleaseManifest, verifyDbArtifacts } from './lib/publish-plan.mjs';
import { r2ClientFromEnv, R2_ENV_KEYS, headObject, putImmutableObject } from './lib/r2.mjs';
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
  const args = ['--force-local', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '--mode=u=rwX,go=rX', '--zstd', '-cf', archivePath, '-C', distDir, '.'];
  const r = spawnSync('tar', args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC', ZSTD_NBTHREADS: '1' } });
  if (r.error) throw new Error(`tar 启动失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar --zstd 退出码 ${r.status}，归档失败`);
}

step('publish:r2');
const t0 = performance.now();
const dryRun = process.env.PUBLISH_DRY_RUN === '1';
try {
  const config = await loadSiteConfig();
  const version = resolveVersion();
  let manifestBody;
  try { manifestBody = await readFile(join(OUT_DIR, MANIFEST_FILE)); }
  catch (error) {
    if (error.code === 'ENOENT') bail(`${show(join(OUT_DIR, MANIFEST_FILE))} 不存在：先 npm run build`);
    throw error;
  }
  const manifest = JSON.parse(manifestBody.toString('utf8'));

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

  const [dbBody, chunksBody] = await Promise.all(['db', 'chunks'].map((kind) => readFile(plan.uploads.find((upload) => upload.kind === kind).path)));
  await verifyDbArtifacts({ manifest, dbConfig: config.db, dbBytes: dbBody, chunksBytes: chunksBody });
  const validatedBodies = new Map([['db', dbBody], ['chunks', chunksBody], ['manifest', manifestBody]]);

  note(`版本 ${version}；manifest 引用 ${plan.verifyKeys.length} 个图片 key`);
  for (const u of plan.uploads) {
    const src = u.kind === 'image' ? join(imagesDir, u.path) : u.path;
    note(`${u.key}  ←  ${show(src)}  [${u.contentType}; ${u.cacheControl}; 相同内容则跳过]`);
  }
  if (!imagesDir) {
    note('IMAGES_DIR 未设置：不上传新图片，只核对 manifest 引用的图片都已在存储里');
  } else {
    note(`${show(imagesDir)}：${plan.images.uploads} 个待传（相同内容会跳过）`);
    if (plan.images.ignored.length) note(`${plan.images.ignored.length} 个文件 manifest 没引用，不传：${plan.images.ignored.slice(0, 5).join(', ')}${plan.images.ignored.length > 5 ? ' …' : ''}`);
    if (plan.images.unsupported.length) warn(`${plan.images.unsupported.length} 个文件扩展名不是 webp，不传：${plan.images.unsupported.join(', ')}`);
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

  // 先归档：打包失败时一个字节都还没传，不留下半份发布
  const tArchive = performance.now();
  createArchive(DIST_DIR, archivePath);
  ok(`${show(archivePath)}：${(await stat(archivePath)).size} 字节，${Math.round(performance.now() - tArchive)} ms`);

  const put = async (u) => {
    const src = u.kind === 'image' ? join(imagesDir, u.path) : u.path;
    const body = validatedBodies.get(u.kind) ?? await readFile(src);
    const result = await putImmutableObject(client, bucket, u.key, body, {
      contentType: u.contentType,
      cacheControl: u.cacheControl,
      ...(u.kind === 'manifest' ? { equivalent: sameReleaseManifest } : {}),
    });
    return { ...result, size: result.body.length };
  };

  for (const u of bulk) {
    const result = await put(u);
    ok(`${u.key}：${result.size} 字节${result.created ? '' : '（相同内容，保留原对象）'}`);
  }

  let skipped = 0;
  let uploaded = 0;
  await mapLimit(imageUploads, UPLOAD_CONCURRENCY, async (u) => {
    const result = await put(u);
    if (result.created) uploaded += 1;
    else skipped += 1;
  });
  if (imageUploads.length) ok(`图片：新传 ${uploaded} 个，已存在跳过 ${skipped} 个`);

  const tVerify = performance.now();
  const missing = (await mapLimit(plan.verifyKeys, HEAD_CONCURRENCY, async (key) => ((await headObject(client, bucket, key)) ? null : key))).filter(Boolean);
  if (missing.length) {
    fail(`manifest 引用了 ${missing.length} 个对象存储里不存在的图片 key（版本 manifest 未上传；把图放进 IMAGES_DIR 再发布）：`);
    for (const k of missing) note(`缺 ${k}`);
    process.exit(1);
  }
  ok(`核对通过：manifest 引用的 ${plan.verifyKeys.length} 个图片 key 全部存在，${Math.round(performance.now() - tVerify)} ms`);

  const result = await put(manifestUpload);
  ok(`${manifestUpload.key}：${result.size} 字节${result.created ? '' : '（相同内容，保留原对象）'}`);
  ok(`publish:r2 完成：版本资源已就绪，未修改生产版本指针，共 ${Math.round(performance.now() - t0)} ms`);
} catch (e) {
  // 计划 / 数据问题的信息本身已逐条列好（e.issues），再打栈只会把手机上的日志推出屏幕。
  // 存储的错误把 HTTP 状态码带上：HEAD 的失败没有响应体，状态码才是定位的线索
  const status = e?.status;
  fail(status ? `对象存储回 HTTP ${status}（${e.name}）：${e.message}（本阶段未修改生产版本指针）` : e.message);
  if (!e.issues) console.error(e.stack);
  process.exit(1);
}
