import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeText } from '../src/normalize.js';

// 测试里需要的不可见字符 / 组合符号一律用码位写，肉眼能看出是哪个字符
const cp = (...codes) => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b);
const ACUTE = cp(0x301); // 组合用的尖音符

test('繁→简：繁体、简体、繁简混写归到同一条', () => {
  assert.equal(normalizeText('漫画作者的契約'), '漫画作者的契约');
  assert.equal(normalizeText('漫画作者的契约'), '漫画作者的契约');
  assert.equal(normalizeText('希望与絕望'), '希望与绝望');
  // 一简对多繁的字也按词典走：髮/發 → 发，裏/裡 → 里
  assert.equal(normalizeText('髮型 發現 裏面 裡面'), '发型发现里面里面');
});

test('NFKC：全角字母数字、半角假名、兼容字统一', () => {
  assert.equal(normalizeText('Ｈｅｌｌｏ　Ｗｏｒｌｄ　１２３'), 'helloworld123');
  assert.equal(normalizeText('ｶﾞﾝﾊﾞﾚ'), 'ガンバレ');
  assert.equal(normalizeText('㈱ ①'), '株1');
});

test('NFKC 在 OpenCC 之前：康熙部首、带圈 / 方括号汉字先折回标准字，再转简', () => {
  // ⾞ U+2F9E、⼾ U+2F3E 是康熙部首，㈶ U+3236 是带括号汉字：从 PDF / OCR 复制来的文本里常见。
  // 反过来先 OpenCC 再 NFKC 会得到繁体的「車站」，简体查询永远对不上。
  assert.equal(normalizeText('⾞站'), '车站');
  assert.equal(normalizeText('㈶団'), '财団');
  assert.equal(normalizeText('⼾'), '户');
});

test('去符号在 OpenCC 之前：被标点隔开的词按去掉标点后的相邻关系转', () => {
  // 「回、覆」去掉顿号后是「回覆」，OpenCC 按词转成「回复」；先 OpenCC 的话第一遍只会逐字转
  // （覆 单独不变），归一化结果再归一化才变成「回复」，查询与索引就对不上了
  assert.equal(normalizeText('回、覆'), '回复');
  assert.equal(normalizeText('回覆'), '回复');
  // 去掉夹在中间的零宽字符后，基字与组合符号重新合成
  assert.equal(normalizeText('e' + ZWSP + ACUTE), cp(0xe9));
});

test('OpenCC 用 OpenCC 标准繁体（from: t）：台湾写法的「著」不折成「着」', () => {
  // 钉住当前选择。若成品按台湾习惯写「看著」「什麼」，改成 from: 'tw' 后这里变成 '看着'——
  // 但 'tw' 也会把单独的「么」折成「幺」，两边都要看过再决定（见 normalize.js 的注释）
  assert.equal(normalizeText('看著'), '看著');
  assert.equal(normalizeText('看着'), '看着');
  assert.equal(normalizeText('什麼'), '什么');
});

test('未分配码位原样透传，不随引擎的 Unicode 版本变化', () => {
  // U+0378 在任何 Unicode 版本里都未分配。用 \p{C} 会把它删掉，而「未分配」的集合每个引擎不一样，
  // 构建端与浏览器端就会算出不同的 tn；只去 Cc / Cf / Co / Cs 才两端一致
  const unassigned = cp(0x378);
  assert.equal(normalizeText('a' + unassigned + 'b'), 'a' + unassigned + 'b');
  // 私用区、控制字符、格式字符仍然去掉
  assert.equal(normalizeText('a' + cp(0xe000) + cp(0x7) + cp(0x200e) + 'b'), 'ab');
});

test('去掉空白、标点、符号、控制字符与变体选择符', () => {
  assert.equal(normalizeText('你好，世界！'), '你好世界');
  assert.equal(normalizeText('  等\t一\n下……！？ '), '等一下');
  assert.equal(normalizeText('「——」『』（）【】·'), '');
  // 零宽空格、零宽连接符、BOM
  assert.equal(normalizeText('好\u200B棒\u200D\uFEFF'), '好棒');
  // 表情符号与它后面的变体选择符（U+FE0F）一起去掉
  assert.equal(normalizeText('赞\u{1F44D} ❤\uFE0F 好'), '赞好');
  assert.equal(normalizeText('Comic★Gallery'), 'comicgallery');
});

test('Latin 转小写（在 NFKC 之后：全角 Ａ 也变 a）', () => {
  assert.equal(normalizeText('ABC Def'), 'abcdef');
  assert.equal(normalizeText('ＡＢＣ'), 'abc');
});

test('日文假名保留，浊音、拗音、长音都在', () => {
  assert.equal(normalizeText('こんにちは、世界'), 'こんにちは世界');
  assert.equal(normalizeText('ちょっと待って！'), 'ちょっと待って');
  assert.equal(normalizeText('コミックブック'), 'コミックブック');
  // 分解形的浊音（か + U+3099）被 NFKC 合成为 が
  assert.equal(normalizeText('が'), 'が');
});

test('空串与只含标点 / 空白得到空串；非字符串报错', () => {
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText('……'), '');
  assert.equal(normalizeText(' \n\t'), '');
  assert.equal(normalizeText('!?., ;:'), '');
  assert.throws(() => normalizeText(undefined), TypeError);
  assert.throws(() => normalizeText(123), TypeError);
});

test('幂等：归一化的结果再归一化不变（查询串与索引文本走同一个函数）', () => {
  const samples = [
    '漫画作者的契約',
    'Ｈｅｌｌｏ　Ｗｏｒｌｄ！',
    'こんにちは、世界',
    '乾坤 乾燥 干燥 著作 看著',
    '髮型 發現 裏面 裡面 後來 什麼',
    'ABC Def ÀÉÎ Straße',
    'ｶﾞﾝﾊﾞﾚ 好\u{1F44D} ❤\uFE0F',
    '…… ！？',
    '⾞站 ㈶団 ⼾',
    '回、覆 反、覆 一、坏',
    'e' + ZWSP + ACUTE,
    'İstanbul ΟΔΟΣ',
    '',
  ];
  for (const s of samples) {
    const once = normalizeText(s);
    assert.equal(normalizeText(once), once, `不幂等：${JSON.stringify(s)} → ${JSON.stringify(once)}`);
  }
});

test('opencc-js 的 ./t2cn 子路径是纯 ESM：不引 Node 内置模块，浏览器也能 import', async () => {
  // 归一化在浏览器检索页里也要跑（铁律 1）。这里检查的是打包器会打进去的那个文件本身。
  const entry = fileURLToPath(import.meta.resolve('opencc-js/t2cn'));
  assert.match(entry, /dist[\\/]esm[\\/]t2cn\.js$/, `解析到的不是 ESM 子路径：${entry}`);
  const src = await readFile(entry, 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /from\s*['"]node:/);
  assert.doesNotMatch(src, /\bprocess\.|__dirname|readFileSync/);
  assert.ok(src.length < 400_000, `t2cn 词典应远小于全量词典，实际 ${src.length} 字节`);
});
