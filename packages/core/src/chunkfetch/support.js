// 取块层内部共用的小工具：信号联动、可中止的 sleep、单调时钟、Range 相关响应头的解析。
//
// 独立成文件是为了让 probe / range / chunked-file 三处的超时与中止语义只有一份实现——
// 这类代码分散着写，最容易出现「一处摘了监听、另一处没摘」这种只在长会话里才暴露的泄漏。

/** 单调时钟（毫秒）。Worker 与浏览器都有 performance.now；没有就退到 Date.now。 */
export function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * 派生一个可单独中止、也随外部 signal 一起中止的 controller。
 *
 * 不用 AbortSignal.any：旧浏览器上没有，而且我们需要在请求结束时主动摘掉监听——外部 signal
 * 往往是页面级、长期存活的，每个请求都往上挂一个不摘的监听就是泄漏。用完必须调 release()。
 * @param {AbortSignal|undefined} signal
 * @returns {{ controller: AbortController, release: () => void }}
 */
export function linkSignal(signal) {
  const controller = new AbortController();
  if (!signal) return { controller, release() {} };
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    controller,
    release() {
      signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 某个 signal 的中止原因。新环境上 signal.reason 就是那个 AbortError；旧浏览器没有 reason 字段，
 * 自己造一个同名错误，调用方按 e.name === 'AbortError' 判「是取消不是失败」时两边一致。
 * @param {AbortSignal} signal
 * @returns {unknown}
 */
export function abortReason(signal) {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException === 'function') return new DOMException('操作已取消', 'AbortError');
  const e = new Error('操作已取消');
  e.name = 'AbortError';
  return e;
}

/**
 * 可中止的等待。退避期间调用方取消了整次读取，就不该再傻等到点。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 解析 `Content-Range: bytes a-b/total`。total 为 `*` 时给 null。
 * 形状不对（缺头、`bytes *\/N`、单位不是 bytes）一律返回 null——调用方据此判「不是真支持」。
 * @param {string|null} header
 * @returns {{ start: number, end: number, total: number|null } | null}
 */
export function parseContentRange(header) {
  if (!header) return null;
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(header);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  const total = m[3] === '*' ? null : Number(m[3]);
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

/**
 * 解析 Content-Length。不是非负整数（缺头、chunked、被压缩层改写成奇怪的值）就当没有。
 * @param {string|null} header
 * @returns {number|null}
 */
export function parseLength(header) {
  if (header === null || header === undefined) return null;
  const s = String(header).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 带固定时限的派生信号：到点就中止，不管有没有数据在动。探测只看响应头，用这个就够；
 * 读 body 的路径要的是「读超时」（有数据就续期），在 range.js 里另有实现。用完必须调 release()。
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs  ≤ 0 表示不设时限
 * @returns {{ signal: AbortSignal, controller: AbortController, expired: () => boolean, release: () => void }}
 */
export function deadline(signal, timeoutMs) {
  const link = linkSignal(signal);
  let expired = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          expired = true;
          link.controller.abort();
        }, timeoutMs)
      : null;
  return {
    signal: link.controller.signal,
    controller: link.controller,
    expired: () => expired,
    release() {
      if (timer !== null) clearTimeout(timer);
      link.release();
    },
  };
}

/**
 * 一份共享的异步工作，多个等待者各自带 signal：某个等待者取消只让它自己收到中止，工作照跑；
 * 所有等待者都取消了，工作才真的中止（没人要的请求不必读完）。
 *
 * 为什么不直接把第一位调用者的 signal 绑在共享 promise 上：检索端「用户改了输入，取消上一条查询、
 * 马上发下一条」时，第二条查询会等在同一次探测 / 同一块上，第一条一取消它就跟着莫名失败——
 * 而它自己的 signal 根本没动。ChunkedFile 的自动探测与同块合并都用这个。
 * @template T
 */
export class SharedJob {
  #controller = new AbortController();
  /** @type {Promise<T>} */
  #promise;
  #waiters = 0;
  #abandoned = false;

  /** @param {(signal: AbortSignal) => Promise<T>} run  立刻开始；signal 只在所有等待者都取消后中止 */
  constructor(run) {
    this.#promise = run(this.#controller.signal);
    // 等待者各自挂了处理；被所有人放弃之后的那次拒绝没人听，不能变成 unhandled rejection
    this.#promise.catch(() => {});
  }

  /** 所有等待者都取消了、工作已被中止：持有它的槽位应立刻换新的，别让后来者接到别人的取消 */
  get abandoned() {
    return this.#abandoned;
  }

  /** @returns {Promise<T>} 工作本身的结果；只供收尾清理用，等结果请走 join() */
  get promise() {
    return this.#promise;
  }

  /**
   * 以自己的 signal 等这份工作。signal 中止 → 只有这位等待者收到它自己的 AbortError。
   * 不带 signal 的等待者视为永不取消，工作也就永远不会因「没人等」而中止。
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  join(signal) {
    if (!signal) {
      this.#waiters += 1;
      return this.#promise;
    }
    if (signal.aborted) return Promise.reject(abortReason(signal));
    this.#waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.#leave();
        reject(abortReason(signal));
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#promise.then(
        (v) => finish(resolve, v),
        (e) => finish(reject, e),
      );
    });
  }

  #leave() {
    this.#waiters -= 1;
    if (this.#waiters > 0) return;
    this.#abandoned = true;
    this.#controller.abort();
  }
}
