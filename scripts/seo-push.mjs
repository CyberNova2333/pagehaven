#!/usr/bin/env node
// push:search —— 页面上线之后，主动把本次新增的页面告诉搜索引擎。
//
// 在发布流水线写 STATUS 的那一步之后跑（部署都完成之后）：推送只对已经能抓到的
// 页面有意义，推早了引擎抓到 404 反而扣分。推什么、怎么分批、回应怎么读，全在 scripts/lib/seo-push.mjs；
// 这里只做接线：
//   1. 读 site.config.yaml、OUT_DIR/manifest.json（缺 → 退 1：没 manifest 就没有页面清单）、
//      OUT_DIR/manifest-previous.json（publish:r2 存下的线上旧 manifest；缺 → 首次发布，推全部）；
//   2. 新 URL = 两份 manifest 页面集合的差集；--all 强制推全部；
//   3. 引擎：IndexNow（config.seo.indexnow_key 非空，或 INDEXNOW_KEY 环境变量覆盖）、
//      百度（BAIDU_PUSH_TOKEN 非空）；Google 没有普通页面的推送接口（sitemap ping 已下线，Indexing API
//      只收招聘 / 直播页），只打印一行说明；
//   4. 推之前先 GET 线上的 key 文件核对：内容不等于 key，说明站点还没部署上去或 CDN 还是旧站——
//      这时推什么都是空的，一条都不发、退 1；
//   5. 每家引擎分批发，任一批失败记下、其它引擎照跑，最后统一退 1；都成功退 0。
//
// 环境变量：
//   INDEXNOW_KEY            覆盖 config.seo.indexnow_key（测试用；日常只改 site.config.yaml）
//   INDEXNOW_ENDPOINT       覆盖 IndexNow 接口地址（测试对本地假服务器）
//   BAIDU_PUSH_TOKEN        百度站长平台该站点的推送 token（凭据，只在 secrets，绝不打印）
//   BAIDU_PUSH_ENDPOINT     覆盖百度接口地址（测试）
//   SITE_ORIGIN             覆盖核对 key 文件时访问的站点源（测试）；推送的 URL 永远用 site.domain
//   SEO_PUSH_SKIP_KEY_CHECK 1 = 跳过 key 文件核对
//   SEO_PUSH_KEY_RETRIES    key 文件核对最多试几次（默认 6）；SEO_PUSH_KEY_RETRY_MS 每次间隔（默认 20000）——
//                           部署刚完成时 CDN / Pages 还没铺开，第一次取到 404 很正常，等一等再判
//   SEO_PUSH_DRY_RUN        1 = 只打印将推什么，不发任何请求（与 --dry-run 同义）
//   GITHUB_STEP_SUMMARY     有就把一张小表追加进去（GitHub Actions 兼容；CNB 不设该变量）
import { appendFile, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { readManifest, MANIFEST_FILE } from './lib/manifest.mjs';
import {
  MANIFEST_PREVIOUS_FILE,
  INDEXNOW_DEFAULT_ENDPOINT,
  BAIDU_DEFAULT_ENDPOINT,
  INDEXNOW_BATCH_MAX,
  BAIDU_BATCH_MAX,
  INDEXNOW_KEY_RE,
  pageUrls,
  newUrls,
  chunk,
  indexNowRequest,
  baiduRequest,
  interpretIndexNow,
  interpretBaidu,
} from './lib/seo-push.mjs';
import { indexNowKeyFile } from './lib/sitemap.mjs';
import { OUT_DIR, ROOT } from './lib/paths.mjs';
import { step, ok, fail, note, warn } from './lib/log.mjs';

const FETCH_TIMEOUT_MS = 15_000;
const KEY_RETRIES = Math.max(1, Number(process.env.SEO_PUSH_KEY_RETRIES) || 6);
const KEY_RETRY_MS = Math.max(0, Number(process.env.SEO_PUSH_KEY_RETRY_MS ?? 20_000));
/** 真推时日志里最多列这么多条 URL：首次发布上千条全打出来，手机上翻不到结果。 */
const LOG_URL_LIMIT = 20;
const GOOGLE_NOTE = '没有普通页面的推送接口（sitemap ping 已下线，Indexing API 只收招聘 / 直播页），靠 robots.txt 的 Sitemap 声明与 Search Console';

const show = (p) => (p.startsWith(ROOT + sep) ? relative(ROOT, p).split(sep).join('/') : p);
const bail = (msg) => {
  fail(msg);
  process.exit(1);
};

/** 带超时的 fetch：引擎接口卡住不该让整个 job 挂到 timeout-minutes。 */
function fetchWithTimeout(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * 网络层错误的一句话。fetch 抛的是干巴巴的「fetch failed」，原因在 cause 里（ECONNREFUSED、ENOTFOUND；
 * 多地址时是 AggregateError）；超时是 TimeoutError。只带错误码或 cause 的原话，不带请求 URL。
 */
function describeFetchError(e) {
  const cause = e?.cause;
  const code = cause?.code || cause?.errors?.find((x) => x?.code)?.code || e?.code;
  const detail = code || (e?.name === 'TimeoutError' ? `超过 ${FETCH_TIMEOUT_MS / 1000} 秒无回应` : cause?.message);
  return detail ? `${e.message}（${detail}）` : e.message;
}

/**
 * 读 OUT_DIR/manifest-previous.json。不存在 → null（首次发布）；存在但不是 JSON → 抛：
 * 一份坏文件不该被当成「首次」而把全站重推一遍，也不该静默推零条。
 */
async function readPrevious() {
  const file = join(OUT_DIR, MANIFEST_PREVIOUS_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${show(file)} 不是合法 JSON（${e.message}）：publish:r2 存下的线上旧 manifest 坏了？想无视它推全部用 --all`, { cause: e });
  }
}

function listUrls(urls, { all = false } = {}) {
  const shown = all ? urls : urls.slice(0, LOG_URL_LIMIT);
  for (const u of shown) note(`  ${u}`);
  if (shown.length < urls.length) note(`  … 还有 ${urls.length - shown.length} 条`);
}

/**
 * 逐批发，收集结果。任一批网络错误或被判失败都记下来，剩下的批照发——上一批 429 了下一批多半也 429，
 * 但一批网络抖动不该让后面几千条都不推。
 * @param {{ name: string, batches: string[][], send: (urls: string[]) => Promise<import('./lib/seo-push.mjs').Verdict> }} engine
 * @returns {Promise<{ name: string, urls: number, batches: number, ok: boolean, summary: string }>}
 */
async function pushEngine({ name, batches, send }) {
  const total = batches.reduce((n, b) => n + b.length, 0);
  const results = [];
  for (const [i, urls] of batches.entries()) {
    const label = batches.length > 1 ? `${name} 第 ${i + 1}/${batches.length} 批（${urls.length} 条）` : `${name}（${urls.length} 条）`;
    let verdict;
    try {
      verdict = await send(urls);
    } catch (e) {
      verdict = { ok: false, message: `请求失败：${describeFetchError(e)}`, warnings: [] };
    }
    (verdict.ok ? ok : fail)(`${label}：${verdict.message}`);
    for (const w of verdict.warnings) warn(`${name}：${w}`);
    results.push(verdict);
  }
  const failed = results.filter((r) => !r.ok);
  const summary = failed.length ? failed.map((r) => r.message).join('；') : results.map((r) => r.message).join('；');
  return { name, urls: total, batches: batches.length, ok: failed.length === 0, summary };
}

/** CI 的运行摘要：一张小表，手机上一眼看到每家引擎的结果。 */
async function writeStepSummary(file, { version, pushed, rows }) {
  const lines = [
    `### push:search（版本 ${version}）`,
    '',
    `本次推送 ${pushed} 条新 URL。`,
    '',
    '| 引擎 | URL 数 | 批次 | 结果 |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.urls} | ${r.batches} | ${r.ok ? '✔' : '✘'} ${r.summary.replace(/\|/g, '\\|')} |`),
    '',
  ];
  await appendFile(file, lines.join('\n'));
}

step('push:search');
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => !['--all', '--dry-run'].includes(a));
if (unknown.length) bail(`不认识的参数：${unknown.join(' ')}（只有 --all 与 --dry-run）`);
const pushAll = args.has('--all');
const dryRun = args.has('--dry-run') || process.env.SEO_PUSH_DRY_RUN === '1';

try {
  const config = await loadSiteConfig();
  const manifest = await readManifest(OUT_DIR);
  if (!manifest) bail(`${show(join(OUT_DIR, MANIFEST_FILE))} 不存在：先 npm run build（或下载 release-out 产物）`);
  const domain = config.site.domain;
  const origin = `https://${domain}`;

  // 页面集合与差集。--all 连旧 manifest 都不读：它就是「无视基线」的意思，基线坏了也不该拦
  const current = pageUrls(manifest, origin);
  const previous = pushAll ? null : await readPrevious();
  let urls;
  if (pushAll) {
    urls = current;
    note(`--all：推全部 ${urls.length} 条 URL`);
  } else if (!previous) {
    urls = current;
    warn(`${show(join(OUT_DIR, MANIFEST_PREVIOUS_FILE))} 不存在：线上没有旧 manifest（首次发布），推全部 ${urls.length} 条 URL`);
  } else {
    urls = newUrls(current, pageUrls(previous, origin));
    note(`线上旧 manifest 版本 ${previous.version ?? '?'}，本版 ${manifest.version}：共 ${current.length} 条 URL，新增 ${urls.length} 条`);
  }

  // 引擎配置
  const indexNowKey = process.env.INDEXNOW_KEY || config.seo?.indexnow_key || '';
  if (indexNowKey && !INDEXNOW_KEY_RE.test(indexNowKey)) bail('IndexNow key 必须是 8–128 位字母、数字与连字符（协议要求）');
  const baiduToken = process.env.BAIDU_PUSH_TOKEN || '';
  const engines = [];
  if (indexNowKey) {
    const endpoint = process.env.INDEXNOW_ENDPOINT || INDEXNOW_DEFAULT_ENDPOINT;
    const keyLocation = `${origin}/${indexNowKeyFile({ seo: { indexnow_key: indexNowKey } }).name}`;
    engines.push({
      name: 'IndexNow',
      batches: chunk(urls, INDEXNOW_BATCH_MAX),
      describe: `host=${domain}，keyLocation=${keyLocation}`,
      send: async (batch) => {
        const { url, init } = indexNowRequest({ endpoint, host: domain, key: indexNowKey, keyLocation, urls: batch });
        const res = await fetchWithTimeout(url, init);
        return interpretIndexNow(res.status);
      },
    });
  } else {
    note('IndexNow：site.config.yaml 的 seo.indexnow_key 为空，不推');
  }
  if (baiduToken) {
    const endpoint = process.env.BAIDU_PUSH_ENDPOINT || BAIDU_DEFAULT_ENDPOINT;
    engines.push({
      name: '百度',
      batches: chunk(urls, BAIDU_BATCH_MAX),
      describe: `site=${origin}（须与站长平台登记的一致）`,
      send: async (batch) => {
        // 请求 URL 带 token，不进日志；错误信息也过一遍抹除
        const { url, init } = baiduRequest({ endpoint, site: origin, token: baiduToken, urls: batch });
        let res;
        try {
          res = await fetchWithTimeout(url, init);
        } catch (e) {
          throw new Error(describeFetchError(e).split(baiduToken).join('***'), { cause: e });
        }
        return interpretBaidu(res.status, (await res.text()).split(baiduToken).join('***'));
      },
    });
  } else {
    note('百度：BAIDU_PUSH_TOKEN 未设置，不推');
  }
  note(`Google：${GOOGLE_NOTE}`);

  if (engines.length === 0) {
    ok('一个引擎都没配置（seo.indexnow_key 为空且没有 BAIDU_PUSH_TOKEN），本步骤无事可做');
    process.exit(0);
  }
  if (urls.length === 0) {
    ok('没有新增页面，不发请求');
    process.exit(0);
  }

  note(`将推 ${urls.length} 条 URL：`);
  listUrls(urls, { all: dryRun });
  for (const e of engines) note(`${e.name}：${urls.length} 条，${e.batches.length} 批；${e.describe}`);
  if (dryRun) {
    ok(`${args.has('--dry-run') ? '--dry-run' : 'SEO_PUSH_DRY_RUN=1'}：只打印，未发任何请求`);
    process.exit(0);
  }

  // key 文件核对：兼作「站点已上线」的探针。部署刚结束时 Pages / CDN 往往还没铺开，第一次取到 404
  // 或连不上很正常，所以隔一会儿再试几次；试完仍不对才判「没上线」，一条都不推
  if (indexNowKey && process.env.SEO_PUSH_SKIP_KEY_CHECK !== '1') {
    const siteOrigin = (process.env.SITE_ORIGIN || origin).replace(/\/+$/, '');
    const keyUrl = `${siteOrigin}/${indexNowKey}.txt`;
    let body = null;
    let status = null;
    let lastError = null;
    for (let attempt = 1; attempt <= KEY_RETRIES; attempt += 1) {
      try {
        const res = await fetchWithTimeout(keyUrl, { method: 'GET' });
        status = res.status;
        body = res.ok ? (await res.text()).trim() : null;
        lastError = null;
      } catch (e) {
        lastError = describeFetchError(e);
        body = null;
      }
      if (body === indexNowKey) break;
      if (attempt < KEY_RETRIES) {
        warn(`key 文件第 ${attempt}/${KEY_RETRIES} 次核对未通过（${lastError ?? `HTTP ${status}`}），${KEY_RETRY_MS / 1000} 秒后再试`);
        await new Promise((r) => setTimeout(r, KEY_RETRY_MS));
      }
    }
    if (body !== indexNowKey) {
      if (lastError) bail(`取不到 key 文件 ${keyUrl}（${lastError}；已试 ${KEY_RETRIES} 次）：站点还没部署或 CDN 还是旧站，一条都不推`);
      bail(`key 文件不在线上：${keyUrl} 回 HTTP ${status}${body != null ? `，内容 ${JSON.stringify(body.slice(0, 40))}` : ''}，与 seo.indexnow_key 不一致（已试 ${KEY_RETRIES} 次）——站点还没部署或 CDN 还是旧站，一条都不推`);
    }
    ok(`key 文件核对通过：${keyUrl}`);
  } else if (indexNowKey) {
    warn('SEO_PUSH_SKIP_KEY_CHECK=1：跳过 key 文件核对');
  }

  const rows = [];
  for (const engine of engines) rows.push(await pushEngine(engine));
  rows.push({ name: 'Google', urls: '—', batches: '—', ok: true, summary: GOOGLE_NOTE });

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeStepSummary(process.env.GITHUB_STEP_SUMMARY, { version: manifest.version, pushed: urls.length, rows });
  }
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) {
    fail(`${failed.map((r) => r.name).join('、')} 推送失败（其它引擎已照常推完）`);
    process.exit(1);
  }
  ok(`push:search 完成：${rows.length - 1} 家引擎各推 ${urls.length} 条`);
} catch (e) {
  fail(e.message);
  if (!e.issues) console.error(e.stack);
  process.exit(1);
}
