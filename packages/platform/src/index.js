// @gallery/platform —— 平台绑定层（CLAUDE.md 铁律 2）。
//
// 这里只有纯函数：配置 schema 与三平台的配置生成器。真正碰文件系统、跑部署命令的
// 在 scripts/（构建期，允许 Node）。保持纯函数是为了两件事：能直接单测；以及
// 任何平台的生成物都能从同一份 site.config.yaml 复现——切平台就是换一个生成器。
export { SiteConfigSchema, parseSiteConfig } from './site-config.js';
export { renderCloudflareHeaders } from './generators/headers.js';
export { renderCloudflareRedirects } from './generators/redirects.js';
export { buildEdgeoneConfig, renderEdgeoneConfig, EDGEONE_MAX_HEADERS, EDGEONE_MAX_REDIRECTS } from './generators/edgeone.js';

/** 平台配置生成物：文件名 → 内容。check 守卫用它比对 packages/platform/generated/。 */
export const GENERATED_FILES = ['_headers', '_redirects', 'edgeone.json'];

/**
 * @param {import('./site-config.js').SiteConfig} config
 * @returns {Record<string, string>}
 */
export async function generateAll(config) {
  const { renderCloudflareHeaders } = await import('./generators/headers.js');
  const { renderCloudflareRedirects } = await import('./generators/redirects.js');
  const { renderEdgeoneConfig } = await import('./generators/edgeone.js');
  return {
    _headers: renderCloudflareHeaders(config),
    _redirects: renderCloudflareRedirects(config),
    'edgeone.json': renderEdgeoneConfig(config),
  };
}
