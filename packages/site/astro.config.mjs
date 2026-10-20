// Astro 配置。站点域名等全部来自 site.config.yaml（经 build:config 生成的 JSON），这里不写死任何值。
import { defineConfig } from 'astro/config';
import siteConfig from './src/generated/site-config.json' with { type: 'json' };

export default defineConfig({
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
