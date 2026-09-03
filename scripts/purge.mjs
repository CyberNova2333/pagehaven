#!/usr/bin/env node
// purge —— 清 CDN 缓存。救火工具，可选：修图走「新 key + 重建」，不靠它（ARCHITECTURE §7）。
//
// EdgeOne 走腾讯云 API 3.0 的 CreatePurgeTask（服务 teo，版本 2022-09-01），鉴权是
// TC3-HMAC-SHA256，签名在 scripts/lib/tc3-sign.mjs（纯函数，有固定向量单测）。请求用全局 fetch，
// 不引 SDK：一个救火脚本不值得一整套依赖。
//
// 凭据：EDGEONE_SECRET_ID / EDGEONE_SECRET_KEY / EDGEONE_ZONE_ID（云 API 的密钥对与站点 ID，
// 与 deploy:edgeone 用的 Makers token 不是一回事）。缺任一个就提示并以 0 退出——purge 是可选的，
// 没配不算发布失败。配了就必须「真清成」才退 0：接口非 2xx、回的不是云 API 的形状、Response 里
// 有 Error、没有 JobId、任一目标进了 FailedList——都退 1。这是显式指定目标的救火命令，人看到 ✔
// 就会认为线上已经换了；把「没干成」打成成功是最糟的失败模式。
//
// 用法：node scripts/purge.mjs [--prefix] [<url> …]
//   · 目标默认是 manifest.json 的 CDN 地址（切版本后最该立刻失效的就是它）；
//   · --prefix 把 Type 从 purge_url 换成 purge_prefix（目标按前缀清，例如整个 db/ 路径）；
//   · PURGE_DRY_RUN=1 打印将发的请求（不含签名）不真发；EDGEONE_API_ENDPOINT 可换接口地址
//     （测试对着本地假服务器跑；国际站账号的接口主机名不同时也用它），只能是协议 + 主机名——
//     签名按根路径与空查询串算，带路径服务端只会回签名错误，报错会指向签名而不是配置。
// 另一家 CDN（ESA）的清缓存未实现：需要 ESA_* 凭据与其接口接入，接入时在这里补第二段。
import { loadSiteConfig } from './lib/config.mjs';
import { signTc3 } from './lib/tc3-sign.mjs';
import { step, ok, fail, note, warn } from './lib/log.mjs';

const SERVICE = 'teo';
const ACTION = 'CreatePurgeTask';
const VERSION = '2022-09-01';
const DEFAULT_ENDPOINT = 'https://teo.tencentcloudapi.com/';
const CRED_KEYS = ['EDGEONE_SECRET_ID', 'EDGEONE_SECRET_KEY', 'EDGEONE_ZONE_ID'];

/** 用法错误（退 2）与预期中的接口 / 配置错误（退 1，不打栈）：信息本身已说清，栈只会把手机上的日志推出屏幕。 */
const usageError = (msg) => Object.assign(new Error(msg), { usage: true });
const expectedError = (msg) => Object.assign(new Error(msg), { expected: true });

/** 命令行：--prefix 开关，其余是目标 URL；不认识的选项直接拒绝，别把它当 URL 发出去。 */
function parseArgs(argv) {
  let type = 'purge_url';
  const targets = [];
  for (const a of argv) {
    if (a === '--prefix') type = 'purge_prefix';
    else if (a.startsWith('-')) throw usageError(`不认识的选项 ${a}；用法：node scripts/purge.mjs [--prefix] [<url> …]`);
    else targets.push(a);
  }
  for (const t of targets) {
    if (!/^https?:\/\/\S+$/.test(t)) throw usageError(`目标必须是完整 URL（http:// 或 https://）：${t}`);
  }
  return { type, targets };
}

/**
 * 接口的 FailedList 按文档是 [{ Reason, Targets: [url…] }]（一条原因对应若干目标）；展平成逐目标一条，
 * 也容忍直接给字符串的形状——数「被拒的目标」而不是「原因条数」，与命令行给的目标数才对得上。
 * @param {unknown} failedList
 * @returns {{ target: string, reason: string }[]}
 */
function rejectedTargets(failedList) {
  const out = [];
  for (const f of Array.isArray(failedList) ? failedList : []) {
    if (typeof f === 'string') out.push({ target: f, reason: '' });
    else if (f && Array.isArray(f.Targets)) for (const t of f.Targets) out.push({ target: String(t), reason: f.Reason ? String(f.Reason) : '' });
    else out.push({ target: JSON.stringify(f), reason: '' });
  }
  return out;
}

/**
 * 把接口回应翻成「成功（JobId）」或抛错。云 API 的业务错误（鉴权、参数）是 HTTP 200 + Response.Error；
 * 非 2xx 来自网关 / 代理 / 指错的端点，正文多半不是云 API 的形状——两种都不能当成功。
 * @param {{ ok: boolean, status: number }} res
 * @param {string} text  响应正文
 * @param {number} targetCount
 * @returns {{ jobId: string, requestId: string }}
 */
function readResponse(res, text, targetCount) {
  const excerpt = text.slice(0, 200);
  if (!res.ok) throw expectedError(`接口回 HTTP ${res.status}（EDGEONE_API_ENDPOINT 指错地方、或被网关 / 代理挡住？）：${excerpt}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw expectedError(`接口回了非 JSON（HTTP ${res.status}）：${excerpt}`);
  }
  const r = body?.Response;
  if (!r || typeof r !== 'object') throw expectedError(`接口回的 JSON 没有 Response 字段（不是云 API 的回应；EDGEONE_API_ENDPOINT 指错地方了？）：${excerpt}`);
  const requestId = r.RequestId ?? '—';
  if (r.Error) throw expectedError(`${ACTION} 失败：${r.Error.Code}：${r.Error.Message}（RequestId ${requestId}）`);
  // 成功的回应一定带 JobId（任务 ID）；没有就不是我们认识的成功，不能猜
  if (typeof r.JobId !== 'string' || r.JobId === '') throw expectedError(`${ACTION} 的回应里没有 JobId，无法确认任务已提交（RequestId ${requestId}）：${excerpt}`);
  const rejected = rejectedTargets(r.FailedList);
  if (rejected.length) {
    fail(`任务 ${r.JobId} 已提交，但 ${rejected.length}/${targetCount} 个目标未被接受（RequestId ${requestId}）：`);
    for (const { target, reason } of rejected) note(`  ${target}${reason ? `：${reason}` : ''}`);
    throw expectedError('有目标未被接受：purge 是指定目标的救火命令，目标被拒就是没清成，不算成功');
  }
  return { jobId: r.JobId, requestId };
}

step('purge');
try {
  const config = await loadSiteConfig();
  const { type, targets } = parseArgs(process.argv.slice(2));
  if (targets.length === 0) targets.push(`https://${config.images.hosts[0]}/${config.db.prefix}manifest.json`);
  note(`Type=${type}；目标 ${targets.length} 个：`);
  for (const t of targets) note(`  ${t}`);

  const env = process.env;
  const missing = CRED_KEYS.filter((k) => !env[k]);
  if (missing.length) {
    warn(`未清 EdgeOne 缓存：缺 ${missing.join(' / ')}（purge 是可选的救火工具，没配不算失败）`);
  } else {
    const endpoint = new URL(env.EDGEONE_API_ENDPOINT || DEFAULT_ENDPOINT);
    if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      throw expectedError(`EDGEONE_API_ENDPOINT 只能是协议 + 主机名（签名按根路径与空查询串算，带路径服务端只会回签名错误）：${env.EDGEONE_API_ENDPOINT}`);
    }
    const payload = JSON.stringify({ ZoneId: env.EDGEONE_ZONE_ID, Type: type, Targets: targets });
    const timestamp = Math.floor(Date.now() / 1000);
    const { headers } = signTc3({
      secretId: env.EDGEONE_SECRET_ID,
      secretKey: env.EDGEONE_SECRET_KEY,
      service: SERVICE,
      host: endpoint.host,
      action: ACTION,
      version: VERSION,
      region: env.EDGEONE_API_REGION || undefined,
      payload,
      timestamp,
    });
    note(`${ACTION}（${SERVICE} ${VERSION}）→ ${endpoint.host}，ZoneId 与签名不打印`);
    if (env.PURGE_DRY_RUN === '1') {
      ok('PURGE_DRY_RUN=1：只打印，不发请求');
    } else {
      // Host 由 fetch 按 URL 自己带；签名里用的就是同一个 endpoint.host
      const { Host: _host, ...sendHeaders } = headers;
      const res = await fetch(endpoint, { method: 'POST', headers: sendHeaders, body: payload });
      const { jobId, requestId } = readResponse(res, await res.text(), targets.length);
      ok(`EdgeOne 清缓存任务已提交：JobId ${jobId}（RequestId ${requestId}），${targets.length} 个目标全部接受`);
    }
  }
  warn('另一家 CDN（ESA）的清缓存未实现：需要 ESA_* 凭据与其接口接入；接入前那一侧靠缓存 TTL 自然过期');
} catch (e) {
  fail(e.message);
  if (!e.usage && !e.expected) console.error(e.stack);
  process.exit(e.usage ? 2 : 1);
}
