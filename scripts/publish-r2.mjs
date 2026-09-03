#!/usr/bin/env node
// publish:r2 —— 上传 gallery-<date>.sqlite / manifest.json / site-<date>.tar.zst / 新图片到对象存储
import { placeholder } from './lib/placeholder.mjs';
placeholder('publish:r2', [
  '只在 CI 里跑：凭据全部来自 secrets（铁律 7），本地没有凭据时直接退出并提示',
  '写入用 S3 兼容 API；图片对象带 Cache-Control: public, max-age=31536000, immutable',
  'DB 用带日期的版本化 key，manifest 指向当前版本（§4）',
]);
