#!/usr/bin/env node
// deploy:<target> —— 把 dist 发到 cloudflare | edgeone | github（ARCHITECTURE §3 三平台矩阵）
import { placeholder } from './lib/placeholder.mjs';
const target = process.argv[2];
const known = ['cloudflare', 'edgeone', 'github'];
if (!known.includes(target)) {
  console.log(`✘ 用法：node scripts/deploy.mjs <${known.join('|')}>`);
  process.exit(2);
}
placeholder(`deploy:${target}`, {
  cloudflare: ['wrangler pages deploy dist（项目名取 site.config.yaml；账号与 token 取 secrets）'],
  edgeone: ['edgeone makers deploy 上传 dist（项目 ID 与 token 取 secrets）'],
  github: ['由 release.yml 的 actions/upload-pages-artifact + actions/deploy-pages 完成；本脚本只校验 dist 的基线文件齐全'],
}[target]);
