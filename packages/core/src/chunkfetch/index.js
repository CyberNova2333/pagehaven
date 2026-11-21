// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 取块层（ARCHITECTURE §6）的汇总导出。只用 fetch / XMLHttpRequest(Worker) / Web Crypto / setTimeout 等
// Web 标准，浏览器、Worker、Node 22 都能跑；由 packages/core/src/index.js 统一对外挂出。
//
// digest.js 的 sha256Hex / sha256HexSync 不从这里出去：db 模块也导出同名函数，两边都 `export *`
// 时这个名字就成了冲突的 star export，按名 import 直接 SyntaxError。对外的只有 db 那一份。
export { probe } from './probe.js';
export { fetchRange, fetchRangeSync, fetchWhole } from './range.js';
export { SourceSet, pickSource } from './sources.js';
export { ChunkedFile, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, DEFAULT_CACHE_CHUNKS } from './chunked-file.js';
export { SyncChunkedFile } from './sync-chunked-file.js';
export { normalizeManifest as normalizeChunkManifest } from './session.js';
export { ChunkFetchError, SWITCH_IMMEDIATELY } from './errors.js';
