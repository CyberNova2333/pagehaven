// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and ADDITIONAL_TERMS.zh-CN.md; ref: ADDITIONAL_TERMS.en.md).
// 取块层用的 sha256：与检索库构建侧（db/chunks.js）是同一份实现，这里只是转发——
// 构建端算摘要、浏览器端验摘要，两边算法必须逐字节一致，所以不能各留一份慢慢长歪。
export { sha256Hex } from '../db/chunks.js';
