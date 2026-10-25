// @gallery/search —— 浏览器端台词检索（sqlite-wasm 读库）+ 页面接线。
//
// 只用 Web 标准 API（铁律 1）：fetch / Web Crypto / WebAssembly。库经 CDN 整份下载并按
// manifest 的 sha256 校验（ARCHITECTURE §6 的退化路径），再交给 core 的 openGalleryDb
// 在内存里打开——FTS5 trigram 在 wasm 里可用，查询逻辑见 query.js。
// 可选的分块 Range 读取与函数版检索是后续优化，接口不变。
export const SEARCH_VERSION = '0.1.0';

export { queryLines, prepareQuery, ftsPhrase, likePattern, RESULT_LIMIT } from './query.js';
export { loadGalleryDb, FETCH_TIMEOUT_MS } from './load.js';
export { mountSearch } from './mount.js';
