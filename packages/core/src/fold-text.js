// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// \p{P} 标点、\p{S} 符号、\p{Z} 分隔符、\s 兜住 ASCII 空白；变体选择符仅影响字形。
// 控制类只列 Cc 控制、Cf 格式（零宽字符、BOM）、Co 私用、Cs 代理，故意不用 \p{C}：\p{C} 还包含
// Cn（未分配码位），而「未分配」取决于各引擎的 Unicode 表版本——构建端的 Node 认识的新汉字
// （扩展区每版都在加），在旧手机浏览器里还是 Cn，用 \p{C} 就会一端保留、一端删掉，同一个函数
// 两端跑出不同的 tn。未分配码位原样透传，两端才一致（代价是新分配的表情符号在旧引擎里留下、
// 新引擎里删掉——台词的主体是汉字，这头轻得多）。
// 已知限制：CJK 部首补充区（U+2E80–2EF3）多数没有 NFKC 映射、属 So，会整字被当符号去掉。
const STRIP_RE = /[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Variation_Selector}\s]+/gu;

/** 归一化的前三步，供建库、查询和检索页的长度检查共用。 */
export function foldText(text) {
  return text.normalize('NFKC').replace(STRIP_RE, '').normalize('NFKC');
}
