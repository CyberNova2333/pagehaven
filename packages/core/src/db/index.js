// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 检索库（构建 / 打开 / 分块摘要）的汇总导出。只用 wasm 与 crypto.subtle，浏览器、Worker、Node 22 都能跑。
// 由 packages/core/src/index.js 统一对外挂出；也可按子路径 `@gallery/core/db/build`、`@gallery/core/db/chunks` 单独引。
// sha256Hex 与 chunkRange 也是取块层要用的：取块层从这里引、不自带实现，对外只挂出这一份。
export { buildGalleryDb, openGalleryDb, initSqlite, tableCounts, TABLES, SCHEMA_SQL } from './build.js';
export { computeChunkManifest, chunkCount, chunkRange, sha256Hex, sha256HexSync, CHUNK_MANIFEST_VERSION } from './chunks.js';
export { openChunkedGalleryDb, consumeChunkedDbError, RANGE_VFS_NAME } from './vfs.js';
