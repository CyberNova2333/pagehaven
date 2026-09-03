// 分块文件：探测 / 取块 / 校验 / 多源 / 退化的组装（ARCHITECTURE §6）。
//
// 这层只认一个 manifest（总长、块大小、整份 sha256、逐块 sha256），与 sqlite 无关：检索端的 VFS
// 把 read(offset, length) 接上就行，阅读器的图片加载共用同一套多源与探测逻辑。
// 校验通过才进缓存、进缓存才交出去——CDN 回错字节、缓存串台、截断在这里被抓住，不会变成
// `database disk image is malformed`。
//
// 重试循环的几条决策：
//   - 原地指数退避重试，连错 maxConsecutiveFailures 次换源；「源在撒谎」类错误（见 errors.js）
//     不退避、直接换源——同一条源上重试大概率还是同样结果。
//   - 换到新源不等：新源没做错什么。
//   - 时间预算只算失败尝试与退避的耗时，不算成功的下载时间——慢但在动的源不该被预算判死，
//     它会被 EMA 选源自然淘汰。卡住的源靠「读超时 × 预算」兜住：只用次数上限的话，次数只会把
//     读超时乘上去。
//   - 同一块的并发请求合并成一次（in-flight map）：VFS 层常常在同一页上连着来几次。合并的请求
//     与首次自动探测都用 SharedJob：每位调用方带自己的 signal，一个取消不连累别人。
//   - 探测阶段被 HEAD 骗过、取块时才暴露「所有源都无视 Range」的，同样要以 needs-whole 报出去：
//     检索端按这个 code（或 needsWhole）退化到整份下载，报 exhausted 它就永远退不了。
import { probe } from './probe.js';
import { fetchRange, fetchWhole } from './range.js';
import { SourceSet } from './sources.js';
import { sha256Hex } from './digest.js';
import { ChunkFetchError, SWITCH_IMMEDIATELY } from './errors.js';
import { abortReason, now, sleep, SharedJob } from './support.js';

/**
 * 逐块摘要清单，与 build:db 产出的 `<db>.chunks.json` 同形（那边由 db 构建模块生成；这里不 import
 * 它——取块层与 sqlite 无关，只认这个形状）。
 * @typedef {object} ChunkManifest
 * @property {number} totalBytes
 * @property {number} chunkSize   对齐块大小；最后一块可以短
 * @property {string} sha256      整份文件的 sha256（hex）
 * @property {string[]} chunks    每块的 sha256（hex），长度 = ceil(totalBytes / chunkSize)
 */

/**
 * @typedef {object} RetryPolicy
 * @property {number} maxAttempts   一块最多尝试次数（跨源累计）。要让每条源都轮得到，它必须
 *                                  ≥ 源数 × maxConsecutiveFailures；不显式给时按这个式子取（下限 6）
 * @property {number} baseDelayMs   第一次退避时长，之后每次翻倍
 * @property {number} maxDelayMs    退避上限
 * @property {number} budgetMs      时间预算：失败尝试耗时 + 退避耗时之和超过就放弃
 */

/**
 * @typedef {object} ChunkedFileOptions
 * @property {SourceSet} sources
 * @property {ChunkManifest} manifest
 * @property {number} [cacheChunks]      LRU 缓存的块数；≤ 0 不缓存
 * @property {Partial<RetryPolicy>} [retry]
 * @property {typeof globalThis.fetch} [fetch]
 * @property {number} [timeoutMs]        单次请求的读超时（连续多久没数据算卡住）
 * @property {(e: { from: string, to: string, chunk: number|null, why: string }) => void} [onSourceSwitch]
 * @property {(e: { chunk: number|null, source: string }) => void} [onChunkVerifyFailed]  chunk 为 null 表示整份下载
 * @property {(e: ProgressEvent) => void} [onProgress]
 */

/**
 * @typedef {{ kind: 'chunk', chunk: number, source: string, bytes: number, ms: number, attempts: number }
 *         | { kind: 'whole', source: string, received: number, total: number }} ProgressEvent
 */

/**
 * @typedef {object} ProbeSummary
 * @property {boolean} needsWhole  所有可用源都不支持 Range，只能整份下载
 * @property {Record<string, import('./probe.js').ProbeResult | { error: Error }>} results  每条源的探测结论
 */

/**
 * 默认重试参数。maxAttempts 这里的 6 只是下限：构造时未显式给它，就取 max(6, 源数 × maxConsecutiveFailures)，
 * 否则三条源时第三条永远轮不到就 exhausted 了（3 + 3 = 6）。
 */
export const DEFAULT_RETRY = Object.freeze({ maxAttempts: 6, baseDelayMs: 200, maxDelayMs: 2000, budgetMs: 60000 });
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_CACHE_CHUNKS = 64;

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** @param {ChunkManifest} m @returns {ChunkManifest} 规范化（hex 小写）后的副本 */
function normalizeManifest(m) {
  if (!m || typeof m !== 'object') throw new TypeError('manifest 必须是对象');
  const { totalBytes, chunkSize, sha256, chunks } = m;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new TypeError('manifest.totalBytes 必须是非负整数');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('manifest.chunkSize 必须是正整数');
  if (typeof sha256 !== 'string' || !HEX_SHA256.test(sha256)) throw new TypeError('manifest.sha256 必须是 64 位 hex');
  const expectedCount = Math.ceil(totalBytes / chunkSize);
  if (!Array.isArray(chunks) || chunks.length !== expectedCount) {
    throw new TypeError(`manifest.chunks 应有 ${expectedCount} 项（totalBytes ${totalBytes} / chunkSize ${chunkSize}），实际 ${chunks?.length}`);
  }
  for (const [i, h] of chunks.entries()) {
    if (typeof h !== 'string' || !HEX_SHA256.test(h)) throw new TypeError(`manifest.chunks[${i}] 不是 64 位 hex`);
  }
  return { totalBytes, chunkSize, sha256: sha256.toLowerCase(), chunks: chunks.map((h) => h.toLowerCase()) };
}

/** @param {unknown} e @returns {ChunkFetchError} */
function asChunkError(e) {
  if (e instanceof ChunkFetchError) return e;
  return new ChunkFetchError('network', e instanceof Error ? e.message : String(e), { cause: e });
}

/** ['timeout','timeout','http-500'] → 'timeout ×2, http-500'：给人看的失败摘要，连续重复折叠。 @param {string[]} reasons */
function summarize(reasons) {
  const parts = [];
  for (const r of reasons) {
    const last = parts[parts.length - 1];
    if (last && last.code === r) last.n += 1;
    else parts.push({ code: r, n: 1 });
  }
  return parts.map((p) => (p.n > 1 ? `${p.code} ×${p.n}` : p.code)).join(', ');
}

export class ChunkedFile {
  #sources;
  #manifest;
  #chunkCount;
  #cacheChunks;
  #retry;
  #fetch;
  #timeoutMs;
  #onSourceSwitch;
  #onChunkVerifyFailed;
  #onProgress;
  /** @type {Map<number, Uint8Array>} 插入顺序即 LRU 顺序：命中时删了再放回去 */
  #cache = new Map();
  /** @type {Map<number, SharedJob<Uint8Array>>} */
  #inflight = new Map();
  /** @type {SharedJob<ProbeSummary>|null} */
  #probing = null;
  #needsWhole = false;

  /** @param {ChunkedFileOptions} opts */
  constructor({
    sources,
    manifest,
    cacheChunks = DEFAULT_CACHE_CHUNKS,
    retry = {},
    fetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onSourceSwitch,
    onChunkVerifyFailed,
    onProgress,
  } = {}) {
    if (!(sources instanceof SourceSet)) throw new TypeError('sources 必须是 SourceSet');
    if (typeof fetch !== 'function') throw new TypeError('fetch 必须是函数');
    this.#sources = sources;
    this.#manifest = normalizeManifest(manifest);
    this.#chunkCount = this.#manifest.chunks.length;
    this.#cacheChunks = Number.isFinite(cacheChunks) ? Math.floor(cacheChunks) : DEFAULT_CACHE_CHUNKS;
    const maxAttempts = retry.maxAttempts ?? Math.max(DEFAULT_RETRY.maxAttempts, sources.ids.length * sources.maxConsecutiveFailures);
    this.#retry = { ...DEFAULT_RETRY, ...retry, maxAttempts };
    for (const k of Object.keys(DEFAULT_RETRY)) {
      if (!(typeof this.#retry[k] === 'number' && this.#retry[k] >= 0)) throw new TypeError(`retry.${k} 必须是非负数`);
    }
    // 存起来的 fetch 永远以局部变量的方式调用，不写 this.#fetch(...)：浏览器里的 fetch 对 this 挑剔，
    // 挂在别的对象上调用会抛 Illegal invocation
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
    this.#onSourceSwitch = onSourceSwitch;
    this.#onChunkVerifyFailed = onChunkVerifyFailed;
    this.#onProgress = onProgress;
  }

  /** @returns {ChunkManifest} 规范化后的副本，不要改 */
  get manifest() {
    return this.#manifest;
  }

  get chunkCount() {
    return this.#chunkCount;
  }

  /**
   * 所有可用源都不支持 Range，只能整份下载。探测前为 false；探测之后取块时才暴露的
   * range-ignored 也会更新它（HEAD 说支持、GET 无视 Range 的那种 CDN）。
   */
  get needsWhole() {
    return this.#needsWhole;
  }

  get sources() {
    return this.#sources;
  }

  /**
   * 第 index 块覆盖的字节区间（end 含）。最后一块可能短。
   * @param {number} index
   * @returns {{ start: number, end: number, length: number }}
   */
  chunkRange(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#chunkCount) {
      throw new RangeError(`块号 ${index} 越界（共 ${this.#chunkCount} 块）`);
    }
    const { chunkSize, totalBytes } = this.#manifest;
    const start = index * chunkSize;
    const end = Math.min(totalBytes, start + chunkSize) - 1;
    return { start, end, length: end - start + 1 };
  }

  /**
   * 探测所有源（每个请求受 timeoutMs 固定时限约束）。尺寸与 manifest 不符的源禁用并记原因（多半是
   * 旧版本文件）；探测失败或超时的也禁用。etag 跨源不比。全部可用源都不支持 Range → needsWhole。
   * 一条可用源都不剩就抛 no-usable-source。
   * 显式调用总是重新探测并重新评估每条源的禁用状态；readChunk / downloadWhole 会在没探测过时自动探一次。
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<ProbeSummary>}
   */
  probeAll({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const job = new SharedJob((jobSignal) => this.#probeAll(jobSignal));
    this.#probing = job;
    // 探测失败不钉死：下一次读再探。这里的 catch 只做重置，错误仍由各位等待者自己的 join 收到
    job.promise.catch(() => {
      if (this.#probing === job) this.#probing = null;
    });
    return job.join(signal);
  }

  /**
   * 没探测过（或上一次探测被所有等待者放弃了）就探一次；正在探就一起等。每位调用方带自己的 signal。
   * @param {AbortSignal|undefined} signal
   */
  #ensureProbed(signal) {
    const job = this.#probing;
    if (job && !job.abandoned) return job.join(signal);
    return this.probeAll({ signal });
  }

  /**
   * 重算 needsWhole：还没被禁用的源全都不支持 Range。一条可用源都没有时不算（那是 no-usable-source 的事）。
   * @returns {boolean}
   */
  #refreshNeedsWhole() {
    const usable = this.#sources.allStats().filter((s) => !s.disabled);
    this.#needsWhole = usable.length > 0 && usable.every((s) => s.rangeSupported === false);
    return this.#needsWhole;
  }

  /** @param {AbortSignal|undefined} signal @returns {Promise<ProbeSummary>} */
  async #probeAll(signal) {
    const doFetch = this.#fetch;
    const total = this.#manifest.totalBytes;
    /** @type {ProbeSummary['results']} */
    const results = {};
    await Promise.all(
      this.#sources.ids.map(async (id) => {
        let r;
        try {
          r = await probe(this.#sources.urlOf(id), { fetch: doFetch, signal, timeoutMs: this.#timeoutMs });
        } catch (e) {
          if (signal?.aborted) throw e;
          this.#sources.disable(id, `探测失败：${e?.code ?? e?.message ?? e}`);
          results[id] = { error: e };
          return;
        }
        // 探测是对每条源的重新评估：上一轮被禁用的源这次探得通就恢复
        this.#sources.enable(id);
        this.#sources.setProbeResult(id, r);
        results[id] = r;
        if (r.total !== null && r.total !== total) {
          this.#sources.disable(id, `尺寸不一致：源上 ${r.total} 字节，manifest ${total} 字节（多半是旧版本文件）`);
        }
      }),
    );
    if (this.#sources.allStats().every((s) => s.disabled)) {
      throw new ChunkFetchError('no-usable-source', `没有可用的源：${this.#describeSources(new Map())}`, { results });
    }
    return { needsWhole: this.#refreshNeedsWhole(), results };
  }

  /**
   * 取第 index 块：校验通过才返回、才进缓存。返回的是缓存里那份，调用方不要改它。
   * 同一块的并发调用共用一次请求，但各自带 signal：一位取消只让它自己收到 AbortError，
   * 请求要等所有等待者都取消才真的中止。
   * @param {number} index
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  readChunk(index, { signal } = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#chunkCount) {
      return Promise.reject(new RangeError(`块号 ${index} 越界（共 ${this.#chunkCount} 块）`));
    }
    const hit = this.#cache.get(index);
    if (hit) {
      this.#cache.delete(index);
      this.#cache.set(index, hit);
      return Promise.resolve(hit);
    }
    const pending = this.#inflight.get(index);
    if (pending && !pending.abandoned) return pending.join(signal);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const job = new SharedJob((jobSignal) => this.#fetchChunk(index, jobSignal));
    this.#inflight.set(index, job);
    // 只清自己占的槽位：被放弃的旧任务收尾时，槽位里可能已经是后来者新起的那一个
    const cleanup = () => {
      if (this.#inflight.get(index) === job) this.#inflight.delete(index);
    };
    job.promise.then(cleanup, cleanup);
    return job.join(signal);
  }

  /** @param {Set<string>} exclude */
  #pickForRange(exclude) {
    return this.#sources.pick({ exclude, filter: (s) => s.rangeSupported !== false });
  }

  /**
   * @param {number} index
   * @param {AbortSignal} signal  这一块所有等待者的联合信号：全取消才中止
   * @returns {Promise<Uint8Array>}
   */
  async #fetchChunk(index, signal) {
    await this.#ensureProbed(signal);
    if (this.#needsWhole) throw this.#needsWholeError(index, new Map());
    const doFetch = this.#fetch;
    const { start, end } = this.chunkRange(index);
    const expectedHash = this.#manifest.chunks[index];
    const { maxAttempts, baseDelayMs, maxDelayMs, budgetMs } = this.#retry;
    /** @type {Map<string, string[]>} 每条源在这一块上的失败 code 序列 */
    const failures = new Map();
    /** @type {Set<string>} 在这一块上已经放弃的源 */
    const excluded = new Set();
    let attempts = 0;
    let spentMs = 0; // 只算失败尝试与退避
    let streak = 0; // 当前源在这一块上的连败
    let current = null;

    for (;;) {
      if (current === null) {
        current = this.#pickForRange(excluded);
        if (current === null && excluded.size > 0) {
          // 每条源都在这一块上放弃过一轮：从头再来，直到预算或次数耗尽
          excluded.clear();
          current = this.#pickForRange(excluded);
        }
        if (current === null) {
          // 挑不出支持 Range 的源，分两种：剩下的源全都不支持 Range（别的块刚把最后一条撒谎的源
          // 揭穿了）→ needs-whole，让调用方退化到整份下载；根本没源了 → 放弃
          throw this.#refreshNeedsWhole() ? this.#needsWholeError(index, failures) : this.#giveUp(index, attempts, spentMs, failures);
        }
        streak = 0;
      }

      const t0 = now();
      this.#sources.onStart(current);
      let bytes = null;
      let error = null;
      try {
        bytes = await fetchRange(this.#sources.urlOf(current), start, end, {
          fetch: doFetch,
          signal,
          timeoutMs: this.#timeoutMs,
        });
        const hash = await sha256Hex(bytes);
        if (hash !== expectedHash) {
          error = new ChunkFetchError('checksum', `块 #${index} 从 ${current} 取到的字节 sha256 不符`, {
            chunk: index,
            source: current,
            expected: expectedHash,
            actual: hash,
          });
        }
      } catch (e) {
        if (signal?.aborted) {
          this.#sources.onCancel(current);
          throw e;
        }
        error = asChunkError(e);
      }
      const ms = now() - t0;

      if (error === null) {
        this.#sources.onSuccess(current, bytes.length, ms);
        this.#remember(index, bytes);
        this.#onProgress?.({ kind: 'chunk', chunk: index, source: current, bytes: bytes.length, ms, attempts: attempts + 1 });
        return bytes;
      }

      attempts += 1;
      spentMs += ms;
      streak += 1;
      this.#sources.onFailure(current, error.code);
      if (error.code === 'checksum') this.#onChunkVerifyFailed?.({ chunk: index, source: current });
      if (!failures.has(current)) failures.set(current, []);
      failures.get(current).push(error.code);
      // 这条源无视 Range：以后分块读都别找它，只留给整份下载。它是最后一条能分块的源时，
      // 就是 needs-whole 而不是 exhausted——探测时被 HEAD 骗过的信号不能在这里丢掉
      if (error.code === 'range-ignored') {
        this.#sources.setRangeSupported(current, false);
        if (this.#refreshNeedsWhole()) throw this.#needsWholeError(index, failures);
      }

      if (attempts >= maxAttempts || spentMs >= budgetMs) throw this.#giveUp(index, attempts, spentMs, failures);

      // 换源的三个理由：源在撒谎；本块在它上面连错到阈值；或者别的块已经把它的连败数推到了阈值——
      // 并行读多块时每块各自再数三次，请求数与首字节延迟都会按块数放大
      const mustSwitch =
        SWITCH_IMMEDIATELY.has(error.code) ||
        streak >= this.#sources.maxConsecutiveFailures ||
        this.#sources.stats(current).consecutiveFailures >= this.#sources.maxConsecutiveFailures;
      if (mustSwitch) {
        excluded.add(current);
        const next = this.#pickForRange(excluded);
        if (next !== null) {
          this.#onSourceSwitch?.({ from: current, to: next, chunk: index, why: error.code });
          current = next;
          streak = 0;
          continue; // 换到新源不等：新源没做错什么
        }
        // 没有别的源可换：原地退避后再试；若当前源已经不能再用于分块读，下一轮重新挑
        if (this.#sources.stats(current).rangeSupported === false || this.#sources.stats(current).disabled) current = null;
      }

      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, streak - 1));
      if (spentMs + delay >= budgetMs) throw this.#giveUp(index, attempts, spentMs, failures);
      await sleep(delay, signal);
      spentMs += delay;
    }
  }

  /** @param {number} index @param {Uint8Array} bytes */
  #remember(index, bytes) {
    if (this.#cacheChunks <= 0) return;
    this.#cache.set(index, bytes);
    while (this.#cache.size > this.#cacheChunks) {
      const oldest = this.#cache.keys().next().value;
      this.#cache.delete(oldest);
    }
  }

  /**
   * 每条源一句话：失败序列 / 已禁用（原因）/ 未尝试。放弃时点名每条源，看日志的人不用再猜。
   * @param {Map<string, string[]>} failures
   */
  #describeSources(failures) {
    return this.#sources
      .allStats()
      .map((s) => {
        const reasons = failures.get(s.id);
        if (reasons?.length) return `${s.id}：${summarize(reasons)}`;
        if (s.disabled) return `${s.id}：已禁用（${s.disabledReason}）`;
        if (s.rangeSupported === false) return `${s.id}：不支持 Range，未尝试`;
        return `${s.id}：未尝试`;
      })
      .join('；');
  }

  /**
   * 所有可用源都不支持 Range：调用方该改走 downloadWhole()。failures 点名是谁在取块时才暴露的。
   * @param {number} index @param {Map<string, string[]>} failures
   */
  #needsWholeError(index, failures) {
    const who = failures.size > 0 ? `（${this.#describeSources(failures)}）` : '';
    return new ChunkFetchError('needs-whole', `所有源都不支持 Range，请改用 downloadWhole()${who}`, {
      chunk: index,
      failures: Object.fromEntries(failures),
    });
  }

  /** @param {number} index @param {number} attempts @param {number} spentMs @param {Map<string, string[]>} failures */
  #giveUp(index, attempts, spentMs, failures) {
    const { start, end } = this.chunkRange(index);
    return new ChunkFetchError(
      'exhausted',
      `块 #${index}（字节 ${start}–${end}）在 ${attempts} 次尝试、失败耗时 ${Math.round(spentMs)} ms 后放弃：${this.#describeSources(failures)}`,
      { chunk: index, attempts, spentMs, failures: Object.fromEntries(failures) },
    );
  }

  /**
   * 读任意字节区间：跨块拼接，块并行取（同块合并）。返回新分配的 Uint8Array，可随意改。
   * 越界抛 RangeError——VFS 适配层要处理「读过 EOF」的话，先用 manifest.totalBytes 夹一下再来。
   * @param {number} offset
   * @param {number} length
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async read(offset, length, { signal } = {}) {
    const { chunkSize, totalBytes } = this.#manifest;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > totalBytes) {
      throw new RangeError(`读取区间 [${offset}, ${offset + length}) 越界（文件 ${totalBytes} 字节）`);
    }
    const out = new Uint8Array(length);
    if (length === 0) return out;
    const first = Math.floor(offset / chunkSize);
    const last = Math.floor((offset + length - 1) / chunkSize);
    const chunks = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) => this.readChunk(first + i, { signal })),
    );
    let pos = 0;
    for (let i = first; i <= last; i++) {
      const chunk = chunks[i - first];
      const chunkStart = i * chunkSize;
      const from = Math.max(offset, chunkStart) - chunkStart;
      const to = Math.min(offset + length, chunkStart + chunk.length) - chunkStart;
      out.set(chunk.subarray(from, to), pos);
      pos += to - from;
    }
    return out;
  }

  /**
   * 整份 GET，验整份 sha256，返回 Uint8Array（不进块缓存——这条路的调用方自己会把整份留在内存里）。
   * 每条可用源最多试一次、不退避：一次 30 MB 的下载没有「原地再来一次」的预算。
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async downloadWhole({ signal } = {}) {
    await this.#ensureProbed(signal);
    const doFetch = this.#fetch;
    const total = this.#manifest.totalBytes;
    /** @type {Map<string, string[]>} */
    const failures = new Map();
    const excluded = new Set();
    let previous = null;
    for (let attempt = 0; attempt < this.#retry.maxAttempts; attempt++) {
      const id = this.#sources.pick({ exclude: excluded });
      if (id === null) break;
      if (previous !== null) this.#onSourceSwitch?.({ from: previous, to: id, chunk: null, why: failures.get(previous).at(-1) });
      const t0 = now();
      this.#sources.onStart(id);
      try {
        const bytes = await fetchWhole(this.#sources.urlOf(id), total, {
          fetch: doFetch,
          signal,
          timeoutMs: this.#timeoutMs,
          onBytes: (received) => this.#onProgress?.({ kind: 'whole', source: id, received, total }),
        });
        const hash = await sha256Hex(bytes);
        if (hash !== this.#manifest.sha256) {
          throw new ChunkFetchError('checksum', `从 ${id} 整份下载的文件 sha256 不符`, {
            source: id,
            expected: this.#manifest.sha256,
            actual: hash,
          });
        }
        this.#sources.onSuccess(id, bytes.length, now() - t0);
        return bytes;
      } catch (e) {
        if (signal?.aborted) {
          this.#sources.onCancel(id);
          throw e;
        }
        const error = asChunkError(e);
        this.#sources.onFailure(id, error.code);
        if (error.code === 'checksum') this.#onChunkVerifyFailed?.({ chunk: null, source: id });
        if (!failures.has(id)) failures.set(id, []);
        failures.get(id).push(error.code);
        excluded.add(id);
        previous = id;
      }
    }
    throw new ChunkFetchError('exhausted', `整份下载失败：${this.#describeSources(failures)}`, { failures: Object.fromEntries(failures) });
  }
}
