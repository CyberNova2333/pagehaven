// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// @gallery/search —— 浏览器端台词检索（sqlite-wasm + Range VFS 读库）+ 页面接线。
//
// 只用 Web 标准 API（铁律 1）：fetch / Worker / XHR(Worker) / Web Crypto / WebAssembly。
// 在 Worker 内通过 @gallery/core/chunkfetch + sqlite3_vfs 按块验摘要按需读取，突破 30 MiB 整库限制；
// 无 Range 支持或无 Worker 时在预算内退化回整份下载，查询逻辑保持一致。
export const SEARCH_VERSION = '0.1.0';

export { queryLines, prepareQuery, ftsPhrase, likePattern, RESULT_LIMIT } from './query.js';
export { loadGalleryDb, FETCH_TIMEOUT_MS, DEFAULT_WHOLE_DOWNLOAD_MAX_BYTES } from './load.js';
export { mountSearch } from './mount.js';
