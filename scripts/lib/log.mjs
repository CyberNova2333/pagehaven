// 极简日志：脚本的输出是给手机上翻构建日志的人看的，短、带符号、一眼能定位。
export const step = (name) => console.log(`\n── ${name} ──`);
export const ok = (msg) => console.log(`✔ ${msg}`);
export const warn = (msg) => console.log(`⚠ ${msg}`);
export const fail = (msg) => console.log(`✘ ${msg}`);
export const note = (msg) => console.log(`  ${msg}`);
