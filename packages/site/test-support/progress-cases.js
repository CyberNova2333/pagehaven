// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 同一份五页章节的历史数据，分别从首页、书架和目录进入。
export const url = '/sample/v1/c1/';
export const progressCases = [
  { raw: JSON.stringify({ url, n: 3 }), resume: 3, toc: 3 },
  { raw: JSON.stringify({ url, n: 99 }), resume: 5, toc: 5 },
  { raw: JSON.stringify({ url, n: '3' }), resume: 1, toc: null },
  { raw: JSON.stringify({ url, n: -1 }), resume: 1, toc: null },
  { raw: JSON.stringify({ url: url + '#p3', n: 3 }), resume: null, toc: null },
  { raw: JSON.stringify({ n: 3 }), resume: null, toc: null },
  { raw: '{broken', resume: null, toc: null },
];
