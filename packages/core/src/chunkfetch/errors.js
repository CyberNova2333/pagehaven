// 取块层统一的错误类型。
//
// 调用方（重试循环、检索端、阅读器）按 code 决策而不是解析 message：哪些错该原地重试、连错到
// 阈值才换源（timeout / network / http-<status> 不分 4xx 5xx / short-body），哪些错说明这条源根本
// 不可信、该立刻换源（range-ignored / content-range-mismatch / checksum）。message 只给人看，所以是中文。
//
// code 一览：
//   探测与取块：'range-ignored' | 'short-body' | 'content-range-mismatch' | 'http-<status>' | 'timeout' | 'network'
//   分块文件：  'checksum'（块或整份摘要不符）| 'exhausted'（预算或次数耗尽，failures 里点名每条源）
//             | 'no-usable-source'（探测后没有一条源能用）| 'needs-whole'（所有源都不支持 Range）
export class ChunkFetchError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]  附在错误对象上的字段（url、块号、各源失败原因……）
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChunkFetchError';
    /** @type {string} */
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * 这些 code 表示「源在撒谎」而不是「源暂时不顺」：同一条源上重试大概率拿到同样的结果
 * （无视 Range 的服务端下次还是无视；缓存里的坏块下次还是那份），所以不退避、直接换源。
 */
export const SWITCH_IMMEDIATELY = new Set(['range-ignored', 'content-range-mismatch', 'checksum']);
