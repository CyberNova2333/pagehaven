#!/usr/bin/env node
// build:sitemap —— data/meta → dist/sitemap.xml
import { placeholder } from './lib/placeholder.mjs';
placeholder('build:sitemap', [
  '输出：dist/sitemap.xml，覆盖作品 / 期 / 话页面，域名取 site.config.yaml 的 site.domain',
]);
