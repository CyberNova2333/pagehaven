#!/usr/bin/env node
// status —— 由发布流水线（.cnb.yml 的 web_trigger_release）在末尾调用，写 STATUS.md（铁律 10：不手改）。
//
// 只收集事实，渲染在 scripts/lib/status.mjs（纯函数）。收集的东西：
//   · out/manifest.json（版本、域名、db 指针）——没有就报错退出：status 只在发布末尾跑，
//     没有 manifest 说明 build 那一步根本没到，写一份「尚未发布」只会盖掉上次的真实状态；
//   · 环境：RELEASE_VERSION / DEPLOY_TARGET（发布流水线给），CNB_BUILD_WEB_URL（构建页链接；
//     也兼容 GitHub Actions 的 GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID 三件套），
//     RELEASE_STARTED_AT（可选，ISO 时间，给了就算耗时）；
//   · dist 文件数（不存在写「—」——STATUS 步骤可能拿不到 dist，构建阶段数好后经 DIST_FILES 传）；
//   · 有对象存储凭据时列出 db 前缀下的对象与图片对象总数（复用 lib/r2.mjs），没有就写「—」。
//
// 有凭据但列不出来（鉴权失败、网络）：STATUS.md 照写，那一格记「列出失败」与原因，然后以非零
// 退出。先写再报错是因为这份文件本身就是给接手的人看的事实记录——「这次列举失败了」也是事实，
// 比留着上次发布的旧清单诚实；非零退出则让 CI 把这一步标红，不静默。
//
// 输出路径默认仓库根 STATUS.md；STATUS_FILE 环境变量可指到别处（测试不碰真文件）。
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { readManifest } from './lib/manifest.mjs';
import { renderStatus } from './lib/status.mjs';
import { r2ClientFromEnv, listAllKeys, listAllObjects } from './lib/r2.mjs';
import { DIST_DIR, OUT_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, fail, note, warn } from './lib/log.mjs';

const show = (p) => (p.startsWith(ROOT + sep) ? relative(ROOT, p).split(sep).join('/') : p);

async function countFiles(dir) {
  let n = 0;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += await countFiles(join(dir, ent.name));
    else if (ent.isFile()) n += 1;
  }
  return n;
}

/** 运行链接：CNB 的构建页优先；再退回 GitHub Actions 的三件套（本地/其它 CI 不写）。 */
function runUrl(env) {
  if (env.CNB_BUILD_WEB_URL) return env.CNB_BUILD_WEB_URL;
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = env;
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : null;
}

function durationMs(env, now) {
  if (!env.RELEASE_STARTED_AT) return null;
  const started = Date.parse(env.RELEASE_STARTED_AT);
  return Number.isFinite(started) && started <= now.getTime() ? now.getTime() - started : null;
}

/**
 * 列举失败的原因，进 STATUS.md 之前把账号 / 桶名 / 端点主机名抹掉（铁律 7）：错误信息里
 * 常带它们（「Access Denied to <桶>」「connect ECONNREFUSED <主机>:<端口>」）。保留错误名、错误码
 * 与 HTTP 状态——接手的人靠这几样判断是凭据过期还是网络问题。
 * @param {any} e
 * @param {{ accountId: string, bucket: string, endpoint: string }} r2
 * @returns {string}
 */
function describeStorageError(e, r2) {
  const head = [e?.name || 'Error'];
  if (e?.code && e.code !== e.name) head.push(e.code);
  const status = typeof e?.status === 'number' && e.status ? e.status : undefined;
  if (status) head.push(`HTTP ${status}`);
  let msg = String(e?.message ?? '');
  // 先抹主机名（它含账号 ID），再抹账号与桶名；host 带端口、hostname 不带，两种写法都可能出现
  const { host, hostname } = new URL(r2.endpoint);
  for (const s of [host, hostname, r2.accountId, r2.bucket]) if (s) msg = msg.split(s).join('…');
  return msg ? `${head.join(' ')}：${msg}` : head.join(' ');
}

step('status');
if (process.env.DEPLOY_ENV === 'preview' || process.env.DEPLOY_TARGET === 'none') {
  note('预览或仅上传不更新生产 STATUS.md');
  process.exit(0);
}
try {
  const manifest = await readManifest(OUT_DIR);
  if (!manifest) {
    throw new Error(
      `${show(join(OUT_DIR, 'manifest.json'))} 不存在：status 只在发布末尾跑，先 pnpm run build（或拿到构建阶段的产物）`,
    );
  }
  const config = await loadSiteConfig();
  const now = new Date();
  const version = process.env.RELEASE_VERSION || manifest.version;
  const target = process.env.DEPLOY_TARGET || '';

  // 发布流水线的 STATUS 步骤可能不下载 dist（上万个文件不该为写个状态再传一遍），
  // 构建阶段数好后经 DIST_FILES 环境变量传过来；本地或没给时才自己数 DIST_DIR。
  let distFiles = null;
  if (/^\d+$/.test(process.env.DIST_FILES ?? '')) {
    distFiles = Number(process.env.DIST_FILES);
    note(`dist 文件数 ${distFiles}（来自 DIST_FILES）`);
  } else if (existsSync(DIST_DIR)) {
    distFiles = await countFiles(DIST_DIR);
    note(`dist 文件数 ${distFiles}`);
  } else {
    note('dist/ 不存在，文件数写「—」');
  }
  if (manifest.db) note(`检索库 ${manifest.db.key}（${manifest.db.size} 字节）`);
  else warn('manifest 没有 db 字段（build:db 没跑？），检索库写「尚未构建」');

  let storage = null;
  let storageError = null;
  const r2 = r2ClientFromEnv();
  if (!r2) {
    warn('没有对象存储凭据，对象清单写「—」');
  } else {
    try {
      const dbObjects = await listAllObjects(r2.client, r2.bucket, config.db.prefix);
      const imageObjects = (await listAllKeys(r2.client, r2.bucket, config.images.prefix)).length;
      storage = { dbPrefix: config.db.prefix, dbObjects, imageObjects };
      note(`对象存储：${config.db.prefix} 下 ${dbObjects.length} 个对象，${config.images.prefix} 下 ${imageObjects} 个对象`);
      if (manifest.db && !dbObjects.some((o) => o.key === manifest.db.key)) {
        warn(`manifest 指向的 ${manifest.db.key} 不在对象存储里（publish:r2 没传上去？）`);
      }
    } catch (e) {
      // 不在这里退出：先把「列出失败」写进 STATUS.md，文件落地后再以非零退出（见文件头）
      storageError = describeStorageError(e, r2);
      fail(`对象存储列举失败：${storageError}`);
    }
  }

  const content = renderStatus({
    version,
    target,
    domain: manifest.site?.domain ?? config.site.domain,
    writtenAt: now.toISOString(),
    runUrl: runUrl(process.env),
    distFiles,
    db: manifest.db,
    storage,
    storageError,
    durationMs: durationMs(process.env, now),
  });
  const file = process.env.STATUS_FILE ? resolve(process.env.STATUS_FILE) : join(ROOT, 'STATUS.md');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  ok(`${show(file)}：版本 ${version}，部署目标 ${target || '—'}`);
  if (storageError) {
    fail('对象存储清单没列出来：STATUS.md 已写（那一格记为「列出失败」），本步骤以非零退出');
    process.exit(1);
  }
} catch (e) {
  fail(e.message);
  if (!e.issues) console.error(e.stack);
  process.exit(1);
}
