// 尚未落地的脚本用它占位（ARCHITECTURE §10 按步落地，先把 package.json 的 scripts 立全）。
// 占位只做一件事：说清自己将来干什么、按哪一节的设计，然后以 0 退出——
// 这样 `npm run build` 的流水线从第一天起就是完整的一条，后续每步只是把占位换成实现。
import { warn, note } from './log.mjs';

/**
 * @param {string} name  脚本名（package.json 里的 script 名）
 * @param {string[]} lines 将来做什么
 */
export function placeholder(name, lines) {
  warn(`${name}：占位，尚未实现（落地顺序见 docs/ARCHITECTURE.md §10）`);
  for (const l of lines) note(l);
}
