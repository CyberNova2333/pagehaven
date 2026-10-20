// push:search 的纯逻辑：哪些页面、哪些是新的、怎么分批、IndexNow 的请求长什么样、回应怎么读。
//
// 脚本（scripts/seo-push.mjs）只做接线：读文件、发请求、打日志、定退出码；「决定」全在这里，
// 所以 IndexNow 的接口约定（批大小、请求体形状、状态码含义）能直接单测，不用真连搜索引擎。
//
// 只推「新页面」而不是每次全推：IndexNow 按频率与配额判滥发，一个上万话的站每次发布都全量推，
// 很快就会被 429 / 配额拒掉；而且已收录的页面重推也没有意义。「新」的判据是两份 manifest
// 的差集——publish:r2 在覆盖线上指针前把旧 manifest 存成 out/manifest-previous.json，本模块只比 URL。
//
// 页面集合与 sitemap 必须是同一批（sitemap 是搜索引擎自己抓的那份，推送是我们主动告诉它的那份，
// 两边不一致会推出 sitemap 里没有的页）：首页、/search/、每个作品 / 期 / 话，顺序也一样。
//
// 不走百度：百度链接提交要站点 token，且长期不推会被降权；本组织不接这条链路。
// Google 没有普通页面的推送接口（sitemap ping 已下线，Indexing API 只收招聘 / 直播页），
// 只靠 robots.txt 的 Sitemap 声明与 Search Console。
//
// IndexNow 的接口（文档约定，本机验不了，首次真推时要看回应）：POST JSON
// { host, key, keyLocation, urlList }，每批 ≤ 10 000 条；key 文件要公开放在
// https://<host>/<key>.txt，引擎按它核对；200 / 202 都算接受，202 表示 key 还没核完。

import { siteUrls, INDEXNOW_KEY_RE } from './sitemap.mjs';

/** 线上旧 manifest 在 OUT_DIR 里的文件名：publish:r2 写、push:search 读。 */
export const MANIFEST_PREVIOUS_FILE = 'manifest-previous.json';

/** IndexNow 的公开接口地址（不是凭据）；环境变量可覆盖，测试对着本地假服务器跑。 */
export const INDEXNOW_DEFAULT_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** 协议规定的单批上限。 */
export const INDEXNOW_BATCH_MAX = 10_000;

/** IndexNow key 的格式：与 sitemap.mjs（写 key 文件）共用同一条，这里只是转发。 */
export { INDEXNOW_KEY_RE };

/**
 * 一次发布里所有页面的绝对 URL：首页、/search/、每个作品 / 期 / 话。顺序与 sitemap 相同。
 * manifest 里的 url 都是站内相对路径（/ 开头、/ 结尾），这里只拼上 origin。
 * @param {import('./manifest.mjs').Manifest} manifest
 * @param {string} origin  形如 https://gallery.example.org（末尾的 / 会被去掉）
 * @returns {string[]}
 */
export function pageUrls(manifest, origin) {
  // 「站点有哪些 URL」只有 sitemap.mjs 一份答案：推送的集合与 sitemap 逐条同源，不会推出 sitemap 里没有的页
  return siteUrls({ series: manifest.series ?? [] }, origin).map((e) => e.loc);
}

/**
 * 本次新增的 URL：current 有、previous 没有，保持 current 的顺序。previous 为 null（首次发布，
 * 线上没有旧 manifest）时全部算新。
 * @param {string[]} current
 * @param {string[]|null} previous
 * @returns {string[]}
 */
export function newUrls(current, previous) {
  if (previous == null) return [...current];
  const seen = new Set(previous);
  return current.filter((u) => !seen.has(u));
}

/**
 * 按 n 个一批切分；最后一批可以不满。空列表得到空数组（零批），不是一个空批。
 * @template T
 * @param {T[]} list
 * @param {number} n
 * @returns {T[][]}
 */
export function chunk(list, n) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`每批大小必须是正整数：${n}`);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 一批 IndexNow 推送的请求。keyLocation 单独给而不是从 host 拼：协议允许 key 文件放在子路径，
 * 调用方决定；本站固定放根目录。
 * @param {{ endpoint: string, host: string, key: string, keyLocation: string, urls: string[] }} p
 * @returns {{ url: string, init: RequestInit }}
 */
export function indexNowRequest({ endpoint, host, key, keyLocation, urls }) {
  if (urls.length > INDEXNOW_BATCH_MAX) throw new Error(`IndexNow 每批最多 ${INDEXNOW_BATCH_MAX} 条 URL，给了 ${urls.length} 条`);
  return {
    url: endpoint,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, keyLocation, urlList: urls }),
    },
  };
}

/**
 * @typedef {object} Verdict
 * @property {boolean} ok
 * @property {string} message    给日志的一行中文
 * @property {string[]} warnings 接受了但有值得看的地方
 */

/**
 * IndexNow 只看状态码（成功时没有正文）。
 * @param {number} status
 * @returns {Verdict}
 */
export function interpretIndexNow(status) {
  const table = {
    200: [true, '已接受（200）'],
    202: [true, '已接受（202：key 尚待引擎核对，之后才生效）'],
    400: [false, '无效请求（400）：请求体格式不对——检查 host / key / keyLocation / urlList 的形状'],
    403: [false, 'key 校验失败（403）：引擎取到的 key 文件内容与 key 不一致，或 keyLocation 取不到'],
    422: [false, 'URL 不属于该 host（422）：urlList 里有不在 host 之下的 URL，或 keyLocation 不在该域名下'],
    429: [false, '太频繁（429）：被判为滥发，本次不推，下次发布再试'],
  };
  const [ok, message] = table[status] ?? [false, `失败（HTTP ${status}）`];
  return { ok, message, warnings: [] };
}
