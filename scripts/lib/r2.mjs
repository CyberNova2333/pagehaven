// 对象存储（S3 兼容 API）的客户端与几个薄封装：列 key、查单个对象、读文本对象、上传。
//
// 这是仓库里唯一碰对象存储写端点的地方：build:manifest 用它核对图片清单，publish:r2 用它上传，
// status 用它列出对象。凭据只从环境变量来（铁律 7：凭据与账号标识只在 secrets），四个变量
// 缺任何一个就返回 null——调用方据此走「未校验 / 未上传」的降级路径，而不是拿半套凭据去撞。
// 本地与检查流水线的 dry-run 正是这种情况：没有凭据，流水线照跑到底，只是不碰存储。
//
// 为什么自己签 SigV4 而不是引 SDK：用到的全部能力就是四个操作（列、HEAD、GET、PUT）加一个
// 签名算法，而 SDK 拖进来 23 个包，其中大半是永远用不到的凭据链（sso / login / ini / process /
// web-identity / imds）。这里只依赖 node:crypto 与 fetch，算法与官方「Signature Version 4」
// 一致：规范请求 → 待签串 → 派生密钥（日期 → 区域 → 服务 → aws4_request）→ 签名。
// 请求头只签 host 与 x-amz-content-sha256、x-amz-date 这一组，与 S3 兼容实现的最小要求一致。
//
// 封装层的约定（三处脚本共用的部分）：分页翻到底、404 → null、上传时的缓存头。所以函数只依赖
// 「有一个 request(method, key, opts) 的对象」，测试可以塞假存储验分页与错误分支，不必真连外部服务。
//
// 存储的直连端点只在这里拼（scripts/ 允许；packages/ 不许出现，check 守卫会拦）。
import { createHash, createHmac } from 'node:crypto';

/** 写凭据所需的四个环境变量；与发布流水线里传给 publish:r2 / status 的一致。 */
export const R2_ENV_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

/** S3 兼容存储固定用这个区域名，服务端不校验它。 */
const REGION = 'auto';
const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/** 账号级端点。只钉平台形态，账号 ID 由环境给。 */
export function r2Endpoint(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * 对象存储的 HTTP 失败。name 按 S3 的语义给（NotFound / Forbidden …），调用方据此判断 404；
 * message 带上方法、key 与状态码——报错要能一眼定位，而不是「FetchError」。
 */
export class StorageError extends Error {
  constructor(message, { status, code }) {
    super(message);
    this.name = code ?? (status === 404 ? 'NotFound' : 'StorageError');
    this.status = status;
    this.code = code;
  }
}

/** RFC 3986 编码：S3 的 canonical URI 比 URL 的编码更严，空格是 %20，~ 不编码。 */
const encodeRfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * 规范查询串：按参数名（同名按值）的字节序排，键值都按 RFC 3986 编码，空值写成 `key=`。
 * @param {Array<[string, string]>} pairs
 */
function canonicalQuery(pairs) {
  return pairs
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * 算一个请求的签名头。纯函数：时间、密钥、payload 哈希都显式传入，同样的输入永远同样的头。
 * @param {object} input
 * @param {string} input.method       GET / HEAD / PUT ...
 * @param {string} input.canonicalUri 已按 RFC 3986 编码的路径（含桶名的路径式寻址）
 * @param {Array<[string, string]>} input.query 规范查询串的原始键值对
 * @param {string} input.host        Host 头（也进规范请求）
 * @param {string} input.payloadHash sha256(正文) 的十六进制
 * @param {string} input.date        ISO 时间（毫秒精度即可，会被截成秒）
 * @param {string} input.accessKeyId
 * @param {string} input.secretAccessKey
 * @returns {{ authorization: string, amzDate: string }}
 */
export function signV4({ method, canonicalUri, query, host, payloadHash, date, accessKeyId, secretAccessKey }) {
  const amzDate = date.replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261020T024150Z
  const dateStamp = amzDate.slice(0, 8);
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    amzDate,
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** 正文 → 字节与 sha256 摘要。字符串按 UTF-8，Uint8Array 原样，流先读完（对象都很小）。 */
async function readBody(body) {
  if (body == null) return { bytes: new Uint8Array(), hash: sha256Hex('') };
  if (typeof body === 'string') return { bytes: Buffer.from(body), hash: sha256Hex(body) };
  if (body instanceof Uint8Array) return { bytes: body, hash: sha256Hex(body) };
  const chunks = [];
  for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  const bytes = Buffer.concat(chunks);
  return { bytes, hash: sha256Hex(bytes) };
}

/**
 * 建一个存储客户端。路径式寻址：桶名进路径，不进主机名——带点的桶名与 IP 形式的端点
 * （测试）都不会因证书 / DNS 出问题。
 * @param {{ endpoint: string, accessKeyId: string, secretAccessKey: string }} input
 */
export function createStorage({ endpoint, accessKeyId, secretAccessKey }) {
  const base = new URL(endpoint);
  if (!/^https?:$/.test(base.protocol)) throw new Error(`存储端点必须是 http(s)：${endpoint}`);
  // 端点自带的路径前缀要保留（换别家 S3 兼容存储时可能挂在子路径下）
  const basePath = base.pathname.replace(/\/$/, '');

  /**
   * 发一个请求。query 是原始键值对（会被排序编码），body 是字符串 / 字节 / 可迭代。
   * 2xx 之外的响应读掉正文、解析成 StorageError 抛出——鉴权失败不能被当成「空清单」。
   * @param {string} method
   * @param {string} bucket
   * @param {string} key  '' 表示桶本身（列对象）
   * @param {{ query?: Array<[string, string]>, body?: any, headers?: Record<string, string> }} [opts]
   */
  async function request(method, bucket, key, { query = [], body, headers = {} } = {}) {
    const { bytes, hash } = await readBody(body);
    // 桶级操作（列对象）的路径带尾斜杠 `/bkt/`：S3 兼容实现按它区分「桶」与「同名对象」，
    // 少了尾斜杠会当成对对象 `bkt` 的请求，列清单直接 404
    const path = `${basePath}/${encodeRfc3986(bucket)}/${key ? key.split('/').map(encodeRfc3986).join('/') : ''}`;
    const host = base.host;
    const { authorization, amzDate } = signV4({
      method,
      canonicalUri: path,
      query,
      host,
      payloadHash: hash,
      date: new Date().toISOString(),
      accessKeyId,
      secretAccessKey,
    });
    const url = `${base.origin}${path}${query.length ? `?${canonicalQuery(query)}` : ''}`;
    const all = {
      'x-amz-content-sha256': hash,
      'x-amz-date': amzDate,
      authorization,
      ...headers,
    };
    if (bytes.length || method === 'PUT' || method === 'POST') all['content-length'] = String(bytes.length);

    let res;
    try {
      res = await fetch(url, { method, headers: all, body: bytes.length ? bytes : undefined });
    } catch (e) {
      throw new StorageError(`${method} ${key || bucket} 失败：${e.message}`, { status: 0 });
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    const detail = text.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? res.statusText;
    throw new StorageError(`${method} ${key || bucket} 失败：HTTP ${res.status}${code ? ` ${code}` : ''} ${detail}`, {
      status: res.status,
      code,
    });
  }

  return { endpoint, host: base.host, request };
}

/**
 * 从环境变量建客户端。四个变量缺任一个返回 null（不抛：缺凭据是正常的本地 / dry-run 状态）。
 * 可选的 R2_ENDPOINT 覆盖端点（测试对着本地假服务器跑；或将来换任何 S3 兼容存储）。
 * 返回值里带上实际用的端点：调用方把错误信息写进入库文件（STATUS.md）前要拿它把主机名抹掉。
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ client: ReturnType<typeof createStorage>, bucket: string, accountId: string, endpoint: string } | null}
 */
export function r2ClientFromEnv(env = process.env) {
  if (R2_ENV_KEYS.some((k) => !env[k])) return null;
  const accountId = env.R2_ACCOUNT_ID;
  const endpoint = env.R2_ENDPOINT || r2Endpoint(accountId);
  const client = createStorage({
    endpoint,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
  return { client, bucket: env.R2_BUCKET, accountId, endpoint };
}

/** ListObjectsV2 的响应是 XML：只认 Contents / Key / Size / NextContinuationToken 这几个。 */
function parseListXml(xml) {
  const tag = (name, s) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
  const unescape = (s) =>
    s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
      const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
      if (named) return named;
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
    key: unescape(tag('Key', m[1]) ?? ''),
    size: Number(tag('Size', m[1]) ?? 0),
  }));
  return {
    contents,
    isTruncated: (tag('IsTruncated', xml) ?? '').trim() === 'true',
    nextToken: tag('NextContinuationToken', xml),
  };
}

/**
 * 列出某前缀下的对象及大小，自动翻页。返回顺序即存储返回的顺序（按 key 的字节序，跨页连续）。
 * 存储报错原样抛：鉴权失败不能被当成「空清单」。
 * @param {{ request: Function }} client
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<{ key: string, size: number }[]>}
 */
export async function listAllObjects(client, bucket, prefix) {
  const objects = [];
  let token;
  do {
    const query = [
      ['list-type', '2'],
      ['prefix', prefix],
      ['max-keys', '1000'],
    ];
    if (token) query.push(['continuation-token', token]);
    // 查询串的键值按原文交给客户端：签名时按 RFC 3986 编码，URL 上也用同一份，两边一致
    const res = await client.request('GET', bucket, '', { query });
    const page = parseListXml(await res.text());
    objects.push(...page.contents);
    token = page.isTruncated ? page.nextToken : undefined;
  } while (token);
  return objects;
}

/**
 * 只要 key 的版本：核对清单用。翻页逻辑只在 listAllObjects 一处，这里只做映射。
 * @param {{ request: Function }} client
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export async function listAllKeys(client, bucket, prefix) {
  return (await listAllObjects(client, bucket, prefix)).map((o) => o.key);
}

/** 404（对象不存在）与其他错误分开：前者是正常答案，后者要抛出去让人看到。 */
function isNotFound(e) {
  return e?.status === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey';
}

/**
 * 查单个对象。不存在返回 null；鉴权失败、网络错误等照常抛。
 * @param {{ request: Function }} client
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<{ size: number, etag: string|undefined } | null>}
 */
export async function headObject(client, bucket, key) {
  try {
    const res = await client.request('HEAD', bucket, key);
    return { size: Number(res.headers.get('content-length') ?? 0), etag: res.headers.get('etag') ?? undefined };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * 读一个文本对象（manifest.json 这类小文件）。不存在返回 null；鉴权失败、网络错误等照常抛——
 * publish:r2 用它取线上旧 manifest，「读不到」与「不存在」必须分开：前者不该被当成首次发布。
 * @param {{ request: Function }} client
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<string | null>}
 */
export async function getObjectText(client, bucket, key) {
  try {
    const res = await client.request('GET', bucket, key);
    return await res.text();
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * 上传一个对象。contentType 与 cacheControl 落成对象元数据——CDN 与浏览器读的就是它们
 * （图片是内容哈希 key，配 immutable 一年；DB 是版本化 key，同理）。
 * @param {{ request: Function }} client
 * @param {string} bucket
 * @param {string} key
 * @param {Uint8Array|string|import('node:stream').Readable} body
 * @param {{ contentType?: string, cacheControl?: string }} [meta]
 * @returns {Promise<{ etag: string|undefined }>}
 */
export async function putObject(client, bucket, key, body, { contentType, cacheControl } = {}) {
  const headers = {};
  if (contentType) headers['content-type'] = contentType;
  if (cacheControl) headers['cache-control'] = cacheControl;
  const res = await client.request('PUT', bucket, key, { body, headers });
  return { etag: res.headers.get('etag') ?? undefined };
}
