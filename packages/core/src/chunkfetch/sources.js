// 多源：每条源的实测统计，以及「下一块找谁取」的策略（ARCHITECTURE §6「多源」）。
//
// 策略与统计分开写：pickSource 是只读 stats 数组的纯函数，不碰 IO，所以能造一份假 stats 直接
// 单测——「慢源该少拿块」这类规则用端到端测是测不准的，结果取决于哪条源先抢到块。
// SourceSet 只负责记账（EMA 吞吐、在途数、连败数、禁用原因、探测结论）并把 pick 委托给它。
//
// 选源公式：weight × 估计吞吐 ÷ (1 + 在途数)。估计吞吐对有样本的源是 EMA，对没样本的源取
// 「已知最好的源」当先验——这样一条新源在 weight=1 时与最好的源打平，平局时新源优先，保证
// 每条源至少被试一次，而不是永远输给已经有成绩的那条。

/**
 * @typedef {object} SourceStats
 * @property {string} id
 * @property {string} url
 * @property {number} weight               先验权重，>0；1 = 中性
 * @property {number} ema                  吞吐 EMA（字节/秒）；samples 为 0 时无意义
 * @property {number} samples              成功次数
 * @property {number} failures             失败总数（不含调用方自己取消的）
 * @property {number} inFlight             在途请求数
 * @property {number} consecutiveFailures  连败数，成功一次清零
 * @property {string|null} lastFailure     最近一次失败的 code
 * @property {boolean} disabled
 * @property {string|null} disabledReason
 * @property {boolean|null} rangeSupported 探测结论；未探测为 null
 * @property {number|null} total           探测到的总长
 * @property {string|null} etag
 */

/**
 * @typedef {object} PickOptions
 * @property {Iterable<string>} [exclude]                 本轮不考虑的源（例如刚在这一块上连错的那条）
 * @property {(s: SourceStats) => boolean} [filter]       额外过滤（例如分块读只要支持 Range 的）
 * @property {number} [maxConsecutiveFailures]            连败到这个数的源视为「冷却中」，只在没别的源时才用
 */

/**
 * 纯策略：从一组 stats 里挑下一条源的 id；没有候选返回 null。
 * @param {SourceStats[]} statsList
 * @param {PickOptions} [opts]
 * @returns {string|null}
 */
export function pickSource(statsList, { exclude = [], filter = () => true, maxConsecutiveFailures = 3 } = {}) {
  const excluded = new Set(exclude);
  const candidates = statsList.filter((s) => !s.disabled && !excluded.has(s.id) && filter(s));
  if (candidates.length === 0) return null;
  // 冷却中的源退到最后：只要还有没连败的源就不碰它；全都在冷却时挑一条也比放弃强——
  // 什么时候放弃由调用方的时间预算与次数上限决定，不在这里
  const healthy = candidates.filter((s) => s.consecutiveFailures < maxConsecutiveFailures);
  const pool = healthy.length > 0 ? healthy : candidates;
  let reference = 0;
  for (const s of pool) if (s.samples > 0 && s.ema > reference) reference = s.ema;
  if (reference <= 0) reference = 1;
  const score = (s) => (s.weight * (s.samples > 0 ? s.ema : reference)) / (1 + s.inFlight);
  let best = null;
  let bestScore = -Infinity;
  for (const s of pool) {
    const v = score(s);
    if (
      best === null ||
      v > bestScore ||
      (v === bestScore && ((s.samples === 0 && best.samples > 0) || (s.samples === 0) === (best.samples === 0) && s.inFlight < best.inFlight))
    ) {
      best = s;
      bestScore = v;
    }
  }
  return best.id;
}

export class SourceSet {
  /** @type {Map<string, SourceStats>} */
  #stats = new Map();
  #alpha;
  #maxConsecutiveFailures;

  /**
   * @param {{ id: string, url: string, weight?: number }[]} sources
   * @param {{ alpha?: number, maxConsecutiveFailures?: number }} [opts]
   *   alpha：EMA 平滑系数，越大越信最近一次；maxConsecutiveFailures：连败到这个数就换源
   */
  constructor(sources, { alpha = 0.3, maxConsecutiveFailures = 3 } = {}) {
    if (!Array.isArray(sources) || sources.length === 0) throw new TypeError('SourceSet 至少要有一条源');
    if (!(alpha > 0 && alpha <= 1)) throw new RangeError('alpha 必须在 (0, 1]');
    if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1) {
      throw new RangeError('maxConsecutiveFailures 必须是正整数');
    }
    this.#alpha = alpha;
    this.#maxConsecutiveFailures = maxConsecutiveFailures;
    for (const src of sources) {
      if (!src || typeof src.id !== 'string' || src.id === '') throw new TypeError('每条源必须有非空字符串 id');
      if (typeof src.url !== 'string' || src.url === '') throw new TypeError(`源 ${src.id} 缺 url`);
      if (this.#stats.has(src.id)) throw new TypeError(`源 id 重复：${src.id}`);
      const weight = src.weight ?? 1;
      if (!(typeof weight === 'number' && weight > 0)) throw new RangeError(`源 ${src.id} 的 weight 必须 > 0`);
      this.#stats.set(src.id, {
        id: src.id,
        url: src.url,
        weight,
        ema: 0,
        samples: 0,
        failures: 0,
        inFlight: 0,
        consecutiveFailures: 0,
        lastFailure: null,
        disabled: false,
        disabledReason: null,
        rangeSupported: null,
        total: null,
        etag: null,
      });
    }
  }

  /** @returns {string[]} 声明顺序 */
  get ids() {
    return [...this.#stats.keys()];
  }

  get maxConsecutiveFailures() {
    return this.#maxConsecutiveFailures;
  }

  /** @param {string} id */
  #get(id) {
    const s = this.#stats.get(id);
    if (!s) throw new RangeError(`未知的源：${id}`);
    return s;
  }

  /** @param {string} id */
  urlOf(id) {
    return this.#get(id).url;
  }

  /** 快照（副本）：策略与调用方只读，不给改内部账本的机会。 @param {string} id @returns {SourceStats} */
  stats(id) {
    return { ...this.#get(id) };
  }

  /** @returns {SourceStats[]} 全部快照，声明顺序 */
  allStats() {
    return [...this.#stats.values()].map((s) => ({ ...s }));
  }

  /** @param {PickOptions} [opts] @returns {string|null} */
  pick(opts = {}) {
    return pickSource(this.allStats(), { maxConsecutiveFailures: this.#maxConsecutiveFailures, ...opts });
  }

  /** @param {string} id */
  onStart(id) {
    this.#get(id).inFlight += 1;
  }

  /**
   * @param {string} id
   * @param {number} bytes
   * @param {number} ms  这次请求从发出到收齐的毫秒数
   */
  onSuccess(id, bytes, ms) {
    const s = this.#get(id);
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.consecutiveFailures = 0;
    const throughput = bytes / (Math.max(ms, 1) / 1000);
    s.ema = s.samples === 0 ? throughput : this.#alpha * throughput + (1 - this.#alpha) * s.ema;
    s.samples += 1;
  }

  /** @param {string} id @param {string} [reason]  错误 code */
  onFailure(id, reason) {
    const s = this.#get(id);
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.failures += 1;
    s.consecutiveFailures += 1;
    s.lastFailure = reason ?? null;
  }

  /** 调用方自己取消了请求：只把在途数减回去，不算源的错。 @param {string} id */
  onCancel(id) {
    const s = this.#get(id);
    s.inFlight = Math.max(0, s.inFlight - 1);
  }

  /** @param {string} id @param {string} reason */
  disable(id, reason) {
    const s = this.#get(id);
    s.disabled = true;
    s.disabledReason = reason;
  }

  /** @param {string} id */
  enable(id) {
    const s = this.#get(id);
    s.disabled = false;
    s.disabledReason = null;
    s.consecutiveFailures = 0;
  }

  /** @param {string} id @param {{ total: number|null, rangeSupported: boolean, etag: string|null }} result */
  setProbeResult(id, { total, rangeSupported, etag }) {
    const s = this.#get(id);
    s.total = total;
    s.rangeSupported = rangeSupported;
    s.etag = etag;
  }

  /** 取块时才发现这条源无视 Range：把探测结论改掉，之后分块读不再找它。 @param {string} id @param {boolean} v */
  setRangeSupported(id, v) {
    this.#get(id).rangeSupported = v;
  }
}
