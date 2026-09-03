// 探测一条源是否真的支持 Range（ARCHITECTURE §6「探测」）。
//
// 为什么不信 HEAD 就完事：CDN 常见的三种撒谎方式——HEAD 被拒（405/501）、HEAD 说支持但 GET
// 无视 Range 直接回 200、206 却不带 Content-Range——每一种照单全收都会让后面的分块读变成静默
// 损坏。所以判定分两级：HEAD 同时给出 Accept-Ranges: bytes 与 Content-Length 才算数；否则发
// GET Range: bytes=0-0，只有 206 + Content-Range 才算真支持，总长从 Content-Range 的 /total
// 取；200 就是服务端无视了 Range。收到 200 时必须立刻中止 body——那是整个文件，不是 1 字节。
//
// HEAD 回 Content-Length: 0 也不算数：一些代理 / CDN 对 HEAD 就是回 0（body 反正不发），照信就会
// 把一条正常的源当成「0 字节的旧文件」禁掉。0 视为「HEAD 不能下结论」，落到 GET 探测——206 的
// Content-Range /total 才是可信的总长。
//
// 探测带固定时限：一条接了连接不回头的源，如果在探测阶段就把整个检索页挂住，后面的多源与
// 预算全都无从谈起。HEAD 超时不再试 GET——黑洞一个方法却放行另一个的 CDN 不值得再等一轮。
import { ChunkFetchError } from './errors.js';
import { deadline, parseContentRange, parseLength } from './support.js';

/**
 * @typedef {object} ProbeResult
 * @property {number|null} total      文件总长；两种探测都拿不到时为 null
 * @property {boolean} rangeSupported
 * @property {string|null} etag       只供同一条源上的缓存校验用；跨源不比（两家 CDN 的 ETag 几乎必然不同）
 */

/** @param {string|null} header */
function acceptsBytes(header) {
  if (!header) return false;
  return header
    .toLowerCase()
    .split(',')
    .some((token) => token.trim() === 'bytes');
}

/**
 * @param {string} url
 * @param {{ fetch?: typeof globalThis.fetch, signal?: AbortSignal, timeoutMs?: number }} [opts]
 *   timeoutMs：每个探测请求从发出到拿到响应头的固定时限；0 或缺省 = 不设
 * @returns {Promise<ProbeResult>}
 */
export async function probe(url, { fetch = globalThis.fetch, signal, timeoutMs = 0 } = {}) {
  let headTotal = null;
  let headEtag = null;
  const head = deadline(signal, timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: head.signal });
    if (res.ok) {
      headTotal = parseLength(res.headers.get('content-length'));
      headEtag = res.headers.get('etag');
      // 0 当作没给：对 HEAD 回 Content-Length: 0 的代理不少，真正的总长要 GET 探测才知道
      if (headTotal === 0) headTotal = null;
      if (acceptsBytes(res.headers.get('accept-ranges')) && headTotal !== null) {
        return { total: headTotal, rangeSupported: true, etag: headEtag };
      }
    }
    // 405 / 501 / 缺头 / Content-Length: 0：HEAD 不能下结论，交给 GET 探测
  } catch (e) {
    if (signal?.aborted) throw e;
    if (head.expired()) {
      throw new ChunkFetchError('timeout', `探测 ${url}：HEAD 超过 ${timeoutMs} ms 没有响应`, { url, cause: e });
    }
    // HEAD 连不上也不急着判死刑——有的 CDN 规则只放行 GET；GET 探测再失败才算失败
  } finally {
    head.release();
  }

  const get = deadline(signal, timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: get.signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (get.expired()) {
        throw new ChunkFetchError('timeout', `探测 ${url}：GET Range 超过 ${timeoutMs} ms 没有响应`, { url, cause: e });
      }
      throw new ChunkFetchError('network', `探测 ${url} 失败：${e?.message ?? e}`, { url, cause: e });
    }
    // 探测只看头。不管 body 是 1 字节还是整个文件都不读——中止连接比读完再丢便宜得多，
    // 而 200 的 body 就是整个文件，读下来等于把探测变成一次整份下载。
    get.controller.abort();
    res.body?.cancel().catch(() => {});

    const etag = res.headers.get('etag') ?? headEtag;
    const bodyLength = parseLength(res.headers.get('content-length'));
    if (res.status === 206) {
      const cr = parseContentRange(res.headers.get('content-range'));
      // 206 却没有合法的 Content-Range：不知道给的是哪一段，等于不支持
      if (!cr) return { total: headTotal, rangeSupported: false, etag };
      return { total: cr.total ?? headTotal, rangeSupported: true, etag };
    }
    if (res.status === 200) {
      return { total: bodyLength ?? headTotal, rangeSupported: false, etag };
    }
    throw new ChunkFetchError(`http-${res.status}`, `探测 ${url}：GET Range 返回 ${res.status}`, { url, status: res.status });
  } finally {
    get.release();
  }
}
