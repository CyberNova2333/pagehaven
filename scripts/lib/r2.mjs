// 对象存储（S3 兼容 API）的客户端与几个薄封装：列 key、查单个对象、读文本对象、上传。
//
// 这是仓库里唯一碰对象存储写端点的地方：build:manifest 用它核对图片清单，publish:r2 用它上传，
// status 用它列出对象。凭据只从环境变量来（铁律 7：凭据与账号标识只在 secrets），四个变量
// 缺任何一个就返回 null——调用方据此走「未校验 / 未上传」的降级路径，而不是拿半套凭据去撞。
// 本地与 checks.yml 的 dry-run 正是这种情况：没有凭据，流水线照跑到底，只是不碰存储。
//
// 为什么封装而不是让各脚本直接 send 命令：分页、404 → null、上传时的缓存头这些约定要三处一致；
// 而且封装后的函数只依赖「一个有 send(cmd) 的对象」，测试可以用假 client 验分页与错误分支，
// 不必真连外部服务。
//
// 存储的直连端点只在这里拼（scripts/ 允许；packages/ 不许出现，check 守卫会拦）。
import { S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

/** 写凭据所需的四个环境变量；与 release.yml 里传给 publish:r2 / status 的一致。 */
export const R2_ENV_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

/** 账号级端点。只钉平台形态，账号 ID 由环境给。 */
export function r2Endpoint(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/**
 * 从环境变量建客户端。四个变量缺任一个返回 null（不抛：缺凭据是正常的本地 / dry-run 状态）。
 * 可选的 R2_ENDPOINT 覆盖端点（测试对着本地假服务器跑；或将来换任何 S3 兼容存储）。
 * 返回值里带上实际用的端点：调用方把错误信息写进入库文件（STATUS.md）前要拿它把主机名抹掉。
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ client: S3Client, bucket: string, accountId: string, endpoint: string } | null}
 */
export function r2ClientFromEnv(env = process.env) {
  if (R2_ENV_KEYS.some((k) => !env[k])) return null;
  const accountId = env.R2_ACCOUNT_ID;
  const endpoint = env.R2_ENDPOINT || r2Endpoint(accountId);
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    // 路径式寻址：桶名不进主机名，带点的桶名与 IP 形式的端点（测试）都不会因证书 / DNS 出问题
    forcePathStyle: true,
    // 新版 SDK 默认给每个请求算 CRC 校验并用 aws-chunked 编码传，S3 之外的实现未必认；
    // 只在协议要求时才算，上传的完整性由我们自己的 sha256 与 key 里的内容哈希兜住
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { client, bucket: env.R2_BUCKET, accountId, endpoint };
}

/**
 * 列出某前缀下的对象及大小，自动翻页。返回顺序即存储返回的顺序（按 key 的字节序，跨页连续）。
 * 存储报错原样抛：鉴权失败不能被当成「空清单」。
 * @param {{ send: (cmd: any) => Promise<any> }} client
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<{ key: string, size: number }[]>}
 */
export async function listAllObjects(client, bucket, prefix) {
  const objects = [];
  let token;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) if (obj.Key) objects.push({ key: obj.Key, size: obj.Size ?? 0 });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

/**
 * 只要 key 的版本：核对清单用。翻页逻辑只在 listAllObjects 一处，这里只做映射。
 * @param {{ send: (cmd: any) => Promise<any> }} client
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export async function listAllKeys(client, bucket, prefix) {
  return (await listAllObjects(client, bucket, prefix)).map((o) => o.key);
}

/** 404（对象不存在）与其他错误分开：前者是正常答案，后者要抛出去让人看到。 */
function isNotFound(e) {
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * 查单个对象。不存在返回 null；鉴权失败、网络错误等照常抛。
 * @param {{ send: (cmd: any) => Promise<any> }} client
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<{ size: number, etag: string|undefined } | null>}
 */
export async function headObject(client, bucket, key) {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: res.ContentLength ?? 0, etag: res.ETag };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * 响应体转字符串。SDK 的 Body 是带 transformToString 的流；假 client 可能直接给字符串、字节或
 * 普通可迭代流，都认——封装的约定是「拿到文本」，不是「拿到某种流」。
 * @param {any} body
 * @returns {Promise<string>}
 */
async function bodyToString(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body.transformToString === 'function') return body.transformToString('utf8');
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  const chunks = [];
  for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 读一个文本对象（manifest.json 这类小文件）。不存在返回 null；鉴权失败、网络错误等照常抛——
 * publish:r2 用它取线上旧 manifest，「读不到」与「不存在」必须分开：前者不该被当成首次发布。
 * @param {{ send: (cmd: any) => Promise<any> }} client
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<string | null>}
 */
export async function getObjectText(client, bucket, key) {
  let res;
  try {
    res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  return bodyToString(res.Body);
}

/**
 * 上传一个对象。contentType 与 cacheControl 落成对象元数据——CDN 与浏览器读的就是它们
 * （图片是内容哈希 key，配 immutable 一年；DB 是版本化 key，同理）。
 * @param {{ send: (cmd: any) => Promise<any> }} client
 * @param {string} bucket
 * @param {string} key
 * @param {Uint8Array|string|import('node:stream').Readable} body
 * @param {{ contentType?: string, cacheControl?: string }} [meta]
 * @returns {Promise<{ etag: string|undefined }>}
 */
export async function putObject(client, bucket, key, body, { contentType, cacheControl } = {}) {
  const res = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    }),
  );
  return { etag: res.ETag };
}
