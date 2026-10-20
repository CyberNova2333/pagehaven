#!/usr/bin/env node
// build:manifest —— data/meta → out/manifest.json，并（有凭据时）核对对象存储上的图片清单。
//
// manifest 是这次发布的目录：每话的 URL、全部图片 key、当前检索库指针（db 字段由之后的
// build:db 填）。形状在 scripts/lib/manifest.mjs。
//
// 图片清单核对（ARCHITECTURE §5「校验 R2 图片清单」）：站点页面引用的每个 key 都必须真在存储里，
// 否则发出去就是一页页的裂图，而且要到用户打开那一话才发现。核对只在环境里有写凭据时做
// （铁律 7：凭据只在 CI 的 secrets 里）；没有凭据就打印「未校验」照常继续——本地与检查流水线
// 的 dry-run 本来就不发布。注意「没凭据就跳过」不等于「发布流水线里一定会核对」：核对发生在
// 哪一步，取决于发布流水线把 R2_* 传给了跑本脚本的哪一步；publish:r2 上传前另有逐 key 的
// head 核对兜底。
//
// 两种用法：
//   · 默认：读 data/ 生成并写出 manifest.json，然后核对；
//   · --verify-only：不读 data/、不写 manifest，只拿 out/ 里已有的 manifest.json 核对。给「凭据只在
//     build 之后的某一步出现」的场景用——不能靠再跑一次默认模式，那会把 build:db 已填的 db 字段
//     清掉。这种用法是明确要求核对，没有凭据就是流水线配错了，报错退出而不是「未校验」。
//
// 先写文件再核对：manifest 忠实描述 data/，核对是它之外的一道闸；失败时文件留在 out/ 里，
// 手机上翻日志的人能拿它对照。缺 key 时控制台只列前几百条 + 总数（首次发布或前缀配错时缺的
// 可能是几十万条，全打出来手机上翻不到头），完整列表写到 out/missing-images.txt，非零退出。
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { loadGallery } from './lib/data.mjs';
import { buildManifest, readManifest, resolveVersion, MANIFEST_FILE } from './lib/manifest.mjs';
import { r2ClientFromEnv, listAllKeys, R2_ENV_KEYS } from './lib/r2.mjs';
import { DATA_DIR, OUT_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, fail, note, warn } from './lib/log.mjs';

/** 缺 key 的完整列表写到这里：在 out/ 不进 dist，release-out 产物会把它一起归档。 */
const MISSING_FILE = 'missing-images.txt';
/** 控制台最多列这么多条缺 key，其余看文件。 */
const MISSING_LOG_LIMIT = 200;

// 仓库内的路径显示成相对形式；OUT_DIR 被环境变量指到仓库外（测试、CI 临时目录）时原样打印
const show = (p) => (p.startsWith(ROOT + sep) ? relative(ROOT, p).split(sep).join('/') : p);
/** 预期中的配置错误：说清楚就退，不打栈——栈只会把手机上的日志推出屏幕。 */
const bail = (msg) => {
  fail(msg);
  process.exit(1);
};

const verifyOnly = process.argv.includes('--verify-only');
const manifestPath = join(OUT_DIR, MANIFEST_FILE);
const missingPath = join(OUT_DIR, MISSING_FILE);

step(verifyOnly ? 'build:manifest --verify-only' : 'build:manifest');
try {
  let manifest;
  if (verifyOnly) {
    manifest = await readManifest(OUT_DIR);
    if (!manifest) bail(`${show(manifestPath)} 不存在：--verify-only 只核对已有的 manifest，先 npm run build:manifest`);
    note(`${show(manifestPath)}：版本 ${manifest.version}，${manifest.imageKeys.length} 个图片 key（只核对，不重写）`);
  } else {
    const config = await loadSiteConfig();
    const version = resolveVersion();
    const gallery = await loadGallery({ dataDir: DATA_DIR, imagePrefix: config.images.prefix });
    const t = gallery.totals;
    note(`${show(DATA_DIR)}：${t.series} 个作品、${t.issues} 期、${t.chapters} 话、${t.pages} 页、${t.boxes} 个台词框`);

    manifest = buildManifest(gallery, config, { version });
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    ok(
      `${show(manifestPath)}：版本 ${version}，${manifest.imageKeys.length} 个图片 key（${t.pages} 页 × webp），` +
        'db 字段留给 build:db',
    );
  }

  // 上一次核对留下的缺 key 列表不能留到这次：这次通过了，它就成了误导
  await rm(missingPath, { force: true });

  const r2 = r2ClientFromEnv();
  if (!r2) {
    if (verifyOnly) bail(`--verify-only 需要对象存储写凭据（${R2_ENV_KEYS.join(' / ')}），缺任一个都无法核对`);
    warn(
      `未校验对象存储清单：没有写凭据（${R2_ENV_KEYS.join(' / ')} 缺任一个）。本地与检查流水线 的 dry-run 就是这种情况；` +
        '发布流水线只有把 R2_* 传给跑本脚本的那一步才会在此核对，publish:r2 上传前另有逐 key 核对兜底',
    );
  } else {
    // 用 manifest 自己记的前缀：它的 imageKeys 就是按这个前缀拼的，两边一定对得上
    const prefix = manifest.images.prefix;
    const t0 = performance.now();
    const existing = new Set(await listAllKeys(r2.client, r2.bucket, prefix));
    note(`对象存储 ${prefix} 下 ${existing.size} 个对象，列出用时 ${Math.round(performance.now() - t0)} ms`);
    const missing = manifest.imageKeys.filter((k) => !existing.has(k));
    if (missing.length) {
      await writeFile(missingPath, missing.join('\n') + '\n');
      fail(`manifest 引用了 ${missing.length} 个对象存储里不存在的图片 key（发布不能引用不存在的图；先传图再发布）：`);
      for (const k of missing.slice(0, MISSING_LOG_LIMIT)) note(`缺 ${k}`);
      if (missing.length > MISSING_LOG_LIMIT) note(`… 还有 ${missing.length - MISSING_LOG_LIMIT} 条没列`);
      note(`完整列表：${show(missingPath)}`);
      process.exit(1);
    }
    ok(`对象存储清单核对通过：manifest 引用的 ${manifest.imageKeys.length} 个图片 key 全部存在`);
  }
} catch (e) {
  // 数据 / 配置问题的信息本身已逐条列好（e.issues），再打栈只会把手机上的日志推出屏幕
  fail(e.message);
  if (!e.issues) console.error(e.stack);
  process.exit(1);
}
