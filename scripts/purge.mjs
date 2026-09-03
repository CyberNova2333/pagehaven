#!/usr/bin/env node
// purge —— 可选：清 CDN 缓存（只用于救火；修图走「新 key + 重建」，见 ARCHITECTURE §7）
import { placeholder } from './lib/placeholder.mjs';
placeholder('purge', ['EdgeOne CreatePurgeTask + ESA PurgeCaches；凭据取 secrets，没有就跳过']);
