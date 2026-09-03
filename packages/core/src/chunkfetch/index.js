// 取块层（ARCHITECTURE §6）的汇总导出。只用 fetch / AbortController / crypto.subtle / setTimeout 等
// Web 标准，浏览器、Worker、Node 22 都能跑；由 packages/core/src/index.js 统一对外挂出。
//
// digest.js 的 sha256Hex 不从这里出去：db 模块也导出同名函数，两边都 `export *` 时这个名字就成了
// 冲突的 star export，按名 import 直接 SyntaxError。对外的 sha256Hex 只有 db 那一份。
export { probe } from './probe.js';
export { fetchRange, fetchWhole } from './range.js';
export { SourceSet, pickSource } from './sources.js';
export { ChunkedFile, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, DEFAULT_CACHE_CHUNKS } from './chunked-file.js';
export { ChunkFetchError, SWITCH_IMMEDIATELY } from './errors.js';
