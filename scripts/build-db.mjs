#!/usr/bin/env node
// build:db —— data/text + data/meta → out/db/gallery-<date>.sqlite（FTS5 trigram）+ .chunks.json
import { placeholder } from './lib/placeholder.mjs';
placeholder('build:db', [
  '输出：out/db/gallery-<date>.sqlite——ARCHITECTURE §4 的表结构，末尾 journal_mode=DELETE、page_size=4096、VACUUM',
  '同时产出 gallery-<date>.sqlite.chunks.json：按 64 KB 逐块 sha256 + 整份 sha256（§6 校验层）',
  '用 sql.js（wasm），不引原生 sqlite；page_size 由 site.config.yaml 的 db.page_size 决定',
]);
