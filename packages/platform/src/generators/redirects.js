// Cloudflare Pages 的 _redirects 生成器。格式：`/from /to 301`，每行一条。
import { GENERATED_BANNER } from './banner.js';

/** @param {import('../site-config.js').SiteConfig} config */
export function renderCloudflareRedirects(config) {
  const out = [`# ${GENERATED_BANNER}`];
  for (const r of config.redirects) out.push(`${r.from} ${r.to} ${r.status}`);
  return out.join('\n') + '\n';
}
