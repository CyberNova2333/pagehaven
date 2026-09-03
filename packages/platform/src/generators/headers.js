// Cloudflare Pages 的 _headers 生成器。
//
// 格式：一行路径（可带 * 通配），其后缩进的每行是「名: 值」。
// 文件顶部的 # 注释是给翻开这个文件的人看的：它是生成物，改了也会被 check 打回。
import { GENERATED_BANNER } from './banner.js';

/** @param {import('../site-config.js').SiteConfig} config */
export function renderCloudflareHeaders(config) {
  const out = [`# ${GENERATED_BANNER}`];
  for (const rule of config.headers) {
    out.push(rule.path);
    for (const [name, value] of Object.entries(rule.headers)) out.push(`  ${name}: ${value}`);
  }
  return out.join('\n') + '\n';
}
