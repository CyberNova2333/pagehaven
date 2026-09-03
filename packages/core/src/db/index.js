// 检索库（构建 / 打开 / 分块摘要）的汇总导出。只用 wasm 与 crypto.subtle，浏览器、Worker、Node 22 都能跑。
// 由 packages/core/src/index.js 统一对外挂出；也可按子路径 `@gallery/core/db/build`、`@gallery/core/db/chunks` 单独引。
// sha256Hex 与 chunkRange 也是取块层要用的：取块层从这里引、不自带实现，对外只挂出这一份。
export { buildGalleryDb, openGalleryDb, initSqlite, tableCounts, TABLES, SCHEMA_SQL } from './build.js';
export { computeChunkManifest, chunkCount, chunkRange, sha256Hex, CHUNK_MANIFEST_VERSION } from './chunks.js';
