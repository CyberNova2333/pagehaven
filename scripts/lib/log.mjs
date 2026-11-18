// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 极简日志：脚本的输出是给手机上翻构建日志的人看的，短、带符号、一眼能定位。
export const step = (name) => console.log(`\n── ${name} ──`);
export const ok = (msg) => console.log(`✔ ${msg}`);
export const warn = (msg) => console.log(`⚠ ${msg}`);
export const fail = (msg) => console.log(`✘ ${msg}`);
export const note = (msg) => console.log(`  ${msg}`);
