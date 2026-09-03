// 取一个字节区间，且只在拿到的字节「恰好是请求的那些」时才返回（ARCHITECTURE §6「取块」）。
//
// 这里的每一条拒绝都对应一种 CDN 上真实发生过的静默损坏：
//   - 请求 bytes=a-b 收到 200：服务端无视了 Range，body 是文件开头。a>0 时照收就是把文件头塞进
//     中间；a==0 时也拒绝——调用方应改走整份下载，而不是让「恰好从 0 开始」的块偷偷成功。
//   - 206 但 Content-Range 与请求不符：给的是别的区间（缓存串台 / 边界被夹）。
//   - 实收字节数 ≠ 请求长度：截断或多给，一个字节都不能差，绝不返回半块。响应带 Content-Encoding
//     时 Content-Length 是压缩后长度，多半是 CDN 对 db/* 误开了压缩（§7 明令关闭，但那是控制台里
//     最容易点错的一项）——拒绝之外还要在 message 里点名，看日志的人在手机上猜不到这个根因。
//   - 接了连接不回数据：用「读超时」兜——每收到一段数据就续期，所以慢但在动的连接不会被误杀，
//     真卡住的才会。总时限由上层的时间预算管，这里不做。
//
// 整份下载（fetchWhole）与分块共用同一个传输内核：同样的读超时、同样的字节数核对、同样的错误码。
import { ChunkFetchError } from './errors.js';
import { linkSignal, parseContentRange, parseLength } from './support.js';

/**
 * @typedef {object} TransferOptions
 * @property {typeof globalThis.fetch} [fetch]
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]   读超时：连续这么久没收到任何字节就中止；0 或缺省 = 不设
 * @property {(received: number) => void} [onBytes]  每收到一段数据回调一次累计字节数
 */

/**
 * 声称的长度对不上时的诊断：带 Content-Encoding 的响应，长度不符几乎必然是压缩造成的。
 * @param {Response} res
 * @returns {{ hint: string, contentEncoding: string|null }}
 */
function encodingHint(res) {
  const contentEncoding = res.headers.get('content-encoding');
  if (!contentEncoding) return { hint: '', contentEncoding: null };
  return {
    hint: `；响应带 Content-Encoding: ${contentEncoding}，请检查 CDN 是否对 db/* 开了压缩（ARCHITECTURE §7）`,
    contentEncoding,
  };
}

/**
 * 发一次请求并把 body 精确读满 expected 字节。
 * accept 在拿到响应头后决定这次响应能不能收：返回 ChunkFetchError 就中止连接并抛出，返回 null 就读 body。
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} expected
 * @param {TransferOptions & { accept: (res: Response) => ChunkFetchError|null }} opts
 * @returns {Promise<Uint8Array>}
 */
async function transfer(url, headers, expected, { fetch, signal, timeoutMs = 0, onBytes, accept }) {
  const link = linkSignal(signal);
  let timedOut = false;
  let timer = null;
  const arm = () => {
    if (!(timeoutMs > 0)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      link.controller.abort();
    }, timeoutMs);
  };
  const classify = (e, received) => {
    if (signal?.aborted) return e; // 调用方自己中止的，原样抛回去，不算源的错
    if (timedOut) {
      return new ChunkFetchError('timeout', `${url} 连续 ${timeoutMs} ms 没有数据（已收 ${received}/${expected} 字节）`, {
        url,
        received,
        expected,
        cause: e,
      });
    }
    return new ChunkFetchError('network', `${url} 传输失败（已收 ${received}/${expected} 字节）：${e?.message ?? e}`, {
      url,
      received,
      expected,
      cause: e,
    });
  };

  arm();
  try {
    let res;
    try {
      res = await fetch(url, { headers, signal: link.controller.signal });
    } catch (e) {
      throw classify(e, 0);
    }
    const rejection = accept(res);
    if (rejection) {
      // 不要的响应立刻断掉：200 的 body 可能是整个文件
      link.controller.abort();
      res.body?.cancel().catch(() => {});
      throw rejection;
    }
    if (!res.body) {
      throw new ChunkFetchError('short-body', `${url} 没有响应体，请求 ${expected} 字节`, { url, received: 0, expected });
    }
    const out = new Uint8Array(expected);
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (e) {
        throw classify(e, received);
      }
      if (step.done) break;
      arm(); // 有数据来就续期：这是「读超时」，不是总时限
      const piece = step.value;
      if (received + piece.length > expected) {
        link.controller.abort();
        throw new ChunkFetchError('short-body', `${url} 给了多于请求的字节（至少 ${received + piece.length}，请求 ${expected}）`, {
          url,
          received: received + piece.length,
          expected,
        });
      }
      out.set(piece, received);
      received += piece.length;
      onBytes?.(received);
    }
    if (received !== expected) {
      throw new ChunkFetchError('short-body', `${url} 只给了 ${received} 字节，请求 ${expected}`, { url, received, expected });
    }
    return out;
  } finally {
    clearTimeout(timer);
    link.release();
  }
}

/**
 * 取 [start, endInclusive] 这一段。返回的 Uint8Array 长度恰好是 endInclusive - start + 1。
 * @param {string} url
 * @param {number} start
 * @param {number} endInclusive
 * @param {TransferOptions} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchRange(url, start, endInclusive, { fetch = globalThis.fetch, signal, timeoutMs = 0, onBytes } = {}) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start) {
    throw new RangeError(`非法的字节区间 ${start}-${endInclusive}`);
  }
  const expected = endInclusive - start + 1;
  return transfer(url, { Range: `bytes=${start}-${endInclusive}` }, expected, {
    fetch,
    signal,
    timeoutMs,
    onBytes,
    accept(res) {
      if (res.status === 200) {
        const why = start > 0 ? '照收就是把文件开头塞进中间' : '请改走整份下载';
        return new ChunkFetchError('range-ignored', `${url} 无视了 Range: bytes=${start}-${endInclusive}，回了 200（${why}）`, {
          url,
          start,
          end: endInclusive,
          status: 200,
        });
      }
      if (res.status !== 206) {
        return new ChunkFetchError(`http-${res.status}`, `${url} bytes=${start}-${endInclusive} 返回 ${res.status}`, {
          url,
          start,
          end: endInclusive,
          status: res.status,
        });
      }
      const cr = parseContentRange(res.headers.get('content-range'));
      if (!cr || cr.start !== start || cr.end !== endInclusive) {
        return new ChunkFetchError(
          'content-range-mismatch',
          `${url} 请求 bytes=${start}-${endInclusive}，Content-Range 却是 ${res.headers.get('content-range') ?? '（缺）'}`,
          { url, start, end: endInclusive, contentRange: res.headers.get('content-range') },
        );
      }
      const declared = parseLength(res.headers.get('content-length'));
      if (declared !== null && declared !== expected) {
        const { hint, contentEncoding } = encodingHint(res);
        return new ChunkFetchError('short-body', `${url} 声称 ${declared} 字节，请求 ${expected}${hint}`, {
          url,
          start,
          end: endInclusive,
          received: 0,
          expected,
          declared,
          contentEncoding,
        });
      }
      return null;
    },
  });
}

/**
 * 整份 GET（不带 Range），且只在长度恰好等于 expectedLength 时返回。用于「不支持 Range」的退化路径；
 * 内容对不对由调用方验整份摘要。
 * @param {string} url
 * @param {number} expectedLength
 * @param {TransferOptions} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchWhole(url, expectedLength, { fetch = globalThis.fetch, signal, timeoutMs = 0, onBytes } = {}) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) throw new RangeError(`非法的长度 ${expectedLength}`);
  return transfer(url, {}, expectedLength, {
    fetch,
    signal,
    timeoutMs,
    onBytes,
    accept(res) {
      if (res.status !== 200) {
        return new ChunkFetchError(`http-${res.status}`, `${url} 整份下载返回 ${res.status}`, { url, status: res.status });
      }
      const declared = parseLength(res.headers.get('content-length'));
      if (declared !== null && declared !== expectedLength) {
        const { hint, contentEncoding } = encodingHint(res);
        return new ChunkFetchError('short-body', `${url} 声称 ${declared} 字节，manifest 说是 ${expectedLength}${hint}`, {
          url,
          received: 0,
          expected: expectedLength,
          declared,
          contentEncoding,
        });
      }
      return null;
    },
  });
}
