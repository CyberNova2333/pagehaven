#!/usr/bin/env node
// build:index —— data/meta → dist/index/<series>.json（元数据检索用的索引分片）
import { placeholder } from './lib/placeholder.mjs';
placeholder('build:index', [
  '输出：dist/index/<series>.json，按作品分片；期数 / 标题 / 话数由前端纯过滤（§6 元数据检索）',
  '分片是为了文件数与单次下载量都可控：一个作品一个文件，不是一话一个',
]);
