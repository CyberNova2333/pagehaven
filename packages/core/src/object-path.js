// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 对象 key 直接进入 CDN URL；配置、发布和浏览器须接受同一组无需转义的相对路径。
export function isSafeObjectKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function isSafeObjectPrefix(value) {
  return typeof value === 'string' && value.endsWith('/') && isSafeObjectKey(value.slice(0, -1));
}
