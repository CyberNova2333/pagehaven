// 腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名（纯函数，只依赖 node:crypto）。
//
// purge 脚本要调 CDN 侧的清缓存接口，而它的鉴权是「把请求正文、时间戳、密钥按固定步骤派生出
// 一个 HMAC」——没有 SDK 也能算，几十行就够，不值得为一个救火工具引一整套 SDK 依赖。
// 步骤与官方文档的「签名方法 v3」一致：
//   1. 规范请求 = POST、路径 /、空查询串、content-type 与 host 两个头、已签名头列表、sha256(正文)
//   2. 待签串   = 算法名、时间戳、凭证范围（日期/服务/tc3_request）、sha256(规范请求)
//   3. 派生密钥 = HMAC 链：("TC3" + 密钥) → 日期 → 服务 → "tc3_request"
//   4. 签名     = hex(HMAC(派生密钥, 待签串))
// 日期取时间戳的 UTC 日期而不是本机时区——否则临近午夜签出来的凭证范围会与服务端对不上。
//
// 输入全部显式传入（含时间戳），同样的输入永远得到同样的头，单测能拿固定向量比对。
// 正文以传入的字符串为准，调用方发请求时必须原样发送同一份字符串——多一个空格签名就对不上。
import { createHash, createHmac } from 'node:crypto';

export const TC3_ALGORITHM = 'TC3-HMAC-SHA256';
export const TC3_CONTENT_TYPE = 'application/json; charset=utf-8';
/** 参与签名的头：只签这两个就够，其余 X-TC-* 头由服务端按原样读。 */
export const TC3_SIGNED_HEADERS = 'content-type;host';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data, encoding) => createHmac('sha256', key).update(data).digest(encoding);

/** 时间戳（秒）对应的 UTC 日期，YYYY-MM-DD。 */
export function utcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/**
 * @param {object} input
 * @param {string} input.secretId
 * @param {string} input.secretKey
 * @param {string} input.service   例如 teo
 * @param {string} input.host      接口主机名（Host 头的值，也进规范请求）
 * @param {string} input.action    例如 CreatePurgeTask
 * @param {string} input.version   接口版本，例如 2022-09-01
 * @param {string} [input.region]  可选；给了才带 X-TC-Region
 * @param {string} input.payload   请求正文（JSON 字符串），发请求时必须原样发送
 * @param {number} input.timestamp Unix 秒
 * @returns {{ headers: Record<string, string> }}
 */
export function signTc3({ secretId, secretKey, service, host, action, version, region, payload, timestamp }) {
  const missing = Object.entries({ secretId, secretKey, service, host, action, version })
    .filter(([, v]) => typeof v !== 'string' || v === '')
    .map(([k]) => k);
  if (typeof payload !== 'string') missing.push('payload');
  if (!Number.isInteger(timestamp) || timestamp <= 0) missing.push('timestamp');
  if (missing.length) throw new Error(`signTc3 缺少或类型不对的参数：${missing.join(', ')}`);

  const date = utcDate(timestamp);
  const canonicalHeaders = `content-type:${TC3_CONTENT_TYPE}\nhost:${host}\n`;
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, TC3_SIGNED_HEADERS, sha256Hex(payload)].join('\n');
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = [TC3_ALGORITHM, String(timestamp), scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`TC3${secretKey}`, date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = hmac(kSigning, stringToSign, 'hex');

  const headers = {
    'Content-Type': TC3_CONTENT_TYPE,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestamp),
    Authorization: `${TC3_ALGORITHM} Credential=${secretId}/${scope}, SignedHeaders=${TC3_SIGNED_HEADERS}, Signature=${signature}`,
  };
  if (region) headers['X-TC-Region'] = region;
  return { headers };
}
