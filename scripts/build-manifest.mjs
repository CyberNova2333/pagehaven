#!/usr/bin/env node
// build:manifest —— data/meta → out/manifest.json（校验对象存储上的图片清单）
import { placeholder } from './lib/placeholder.mjs';
placeholder('build:manifest', [
  '输入：data/meta/*.yaml（作品 / 期 / 话 / 页，页带内容哈希）',
  '输出：out/manifest.json——全部图片 key、每话 URL、DB 当前版本指针',
  '有对象存储凭据（只在 CI）时逐 key 校验存在；没有就只生成清单并提示未校验',
]);
