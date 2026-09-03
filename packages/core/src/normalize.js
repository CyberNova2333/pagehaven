// 台词归一化：data/text 里的 tn 与检索页的查询串走的同一条路（ARCHITECTURE §4、§6）。
//
// 为什么是这几步、这个顺序：
//   1. NFKC：全角字母数字、半角假名、兼容汉字、康熙部首统一成标准形（Ｈｅｌｌｏ → Hello，ｶﾞ → ガ，
//      ⾞ U+2F9E → 車，㈶ → 財）。必须排在 OpenCC 之前：OpenCC 的词典只认标准汉字，兼容字与部首
//      先折回标准形它才转得动。反过来先 OpenCC 再 NFKC 的话，⾞ 会先被放过、再被 NFKC 变成繁体的 車，
//      之后再没有机会转简——索引里留下繁体，查询侧敲的简体永远对不上。从 PDF / OCR 复制来的文本里
//      车 / 长 / 门 / 见 被映到部首码位并不罕见。
//   2. 去掉空白、标点、符号、控制字符：trigram 是按「连续三个字」匹配的，台词里的「……」「！？」与换行
//      会把本来连着的三个字切开；查询串里也没人会认真敲标点。
//      变体选择符（U+FE0x / U+E01xx）不属于上面任何一类，但它只影响字形、不影响字义，同样去掉——
//      否则一个表情符号被去掉后会留下一个看不见的尾巴。
//      去符号排在 OpenCC 之前，是为了让 OpenCC 两次看到的相邻关系一样：「回、覆」去掉顿号后是「回覆」，
//      OpenCC 按词转成「回复」；若先 OpenCC 再去符号，第一遍只能逐字转（覆 单独不变），去掉顿号后
//      第二遍才按词转——归一化的结果再归一化会变，查询串与索引对不上。用词典里全部词条逐条插入标点
//      验证过：这个顺序只剩词典自身不稳定的条目（薴 → 苧 → 苎 那一类），换任何顺序都在。
//   3. 再做一次 NFKC：去掉夹在中间的零宽字符后，原本被隔开的基字与组合符号变成相邻，要让它们合成，
//      否则 e + U+0301 与 é 这两种写法归一化后仍是两个串。
//   4. OpenCC 繁→简：汉化成品有繁有简，读者敲的也有繁有简。索引与查询两边都归到简体，
//      「漫画作者的契約」与「漫画作者的契约」才是同一条记录。OpenCC 的输出（单字与全部词条都验过）
//      本身是 NFKC 稳定且不含符号的，放在最后不会破坏前三步。
//   5. 转小写：放在 NFKC 之后，全角 Ａ 才会先变成 A 再变成 a。
//
// 必须是纯函数且幂等——normalizeText(normalizeText(s)) === normalizeText(s)——因为查询串与
// 索引文本走同一个函数，任何一步都不能依赖外部状态或调用次数。
//
// 只用 Web 标准（铁律 1）：opencc-js 是纯 JS，./t2cn 子路径只带繁→简这一个方向的词典（约 110 KB，
// 台 / 港地区变体表也在里面，全量双向是 1.2 MB），浏览器检索页与 Node 构建期都 import 得到、
// 不 fetch 任何词典文件。
import { Converter } from 'opencc-js/t2cn';

/** @type {((s: string) => string) | null} */
let toSimplified = null;

/**
 * 转换器只建一次：建 trie 要把整份词典走一遍，几毫秒与几 MB；模块级懒初始化，
 * import 本模块不付这个代价，第一次真用到才建。
 *
 * from 用 't'（OpenCC 标准繁体）而不是 'tw' / 'hk'：地区变体表会把「著」折成「着」这类地区写法，
 * 但也会把单独的「么」折成「幺」（简体查询串「么」就变了），要不要换取决于成品用的是哪套写法，
 * 见 normalize.test.js 里钉住的「看著」。
 */
function converter() {
  if (!toSimplified) toSimplified = Converter({ from: 't', to: 'cn' });
  return toSimplified;
}

// \p{P} 标点、\p{S} 符号、\p{Z} 分隔符、\s 兜住 ASCII 空白；变体选择符见文件头第 2 条。
// 控制类只列 Cc 控制、Cf 格式（零宽字符、BOM）、Co 私用、Cs 代理，故意不用 \p{C}：\p{C} 还包含
// Cn（未分配码位），而「未分配」取决于各引擎的 Unicode 表版本——构建端的 Node 认识的新汉字
// （扩展区每版都在加），在旧手机浏览器里还是 Cn，用 \p{C} 就会一端保留、一端删掉，同一个函数
// 两端跑出不同的 tn。未分配码位原样透传，两端才一致（代价是新分配的表情符号在旧引擎里留下、
// 新引擎里删掉——台词的主体是汉字，这头轻得多）。
// 已知限制：CJK 部首补充区（U+2E80–2EF3）多数没有 NFKC 映射、属 So，会整字被当符号去掉。
const STRIP_RE = /[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Variation_Selector}\s]+/gu;

/**
 * 台词 / 查询串 → 归一化文本 tn。
 * @param {string} t
 * @returns {string}
 */
export function normalizeText(t) {
  if (typeof t !== 'string') throw new TypeError('normalizeText 只接受字符串');
  if (t === '') return '';
  const folded = t.normalize('NFKC').replace(STRIP_RE, '').normalize('NFKC');
  return converter()(folded).toLowerCase();
}
