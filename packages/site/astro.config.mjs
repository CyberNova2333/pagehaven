// Astro 配置。站点域名等全部来自 site.config.yaml（经 build:config 生成的 JSON），这里不写死任何值。
import { defineConfig } from 'astro/config';
import siteConfig from './src/generated/site-config.json' with { type: 'json' };

export default defineConfig({
  // 图片一律经 CDN 直出，站点里没有 <Image>/<Picture>，构建期不需要任何图像处理。
  // 默认服务是 astro/assets/services/sharp，它会把 sharp（含 LGPL 的 libvips 二进制）
  // 拖进依赖树；换成 Astro 自带的 noop 服务（transform 原样返回）就没有这个负担。
  // 代价：以后真要写 <Image> 时不会做转码/缩放，得先换回 sharp 或另配服务。
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
  site: `https://${siteConfig.site.domain}`,
  output: 'static',
  // dist 在仓库根：check 守卫、三套 deploy 都只认这一个目录
  outDir: '../../dist',
  vite: {
    optimizeDeps: {
      // sqlite-wasm 自带 wasm 资源、用 import.meta.url 定位；Vite 预构建会把这段 URL 改坏
      exclude: ['@sqlite.org/sqlite-wasm'],
    },
  },
  build: {
    // 每个页面一个目录 + index.html：/a/b/ 在三平台上行为一致（GitHub Pages 不做 .html 重写）
    format: 'directory',
    // 样式内联：省掉独立 CSS 文件，文件数预算（18 000）留给每话一 HTML
    inlineStylesheets: 'always',
  },
  trailingSlash: 'always',
  compressHTML: true,
});
