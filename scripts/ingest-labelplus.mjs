#!/usr/bin/env node
// ingest:labelplus —— LabelPlus txt → data/text/<series>/<chapter>.json（ARCHITECTURE §4、§5）
import { placeholder } from './lib/placeholder.mjs';
placeholder('ingest:labelplus', [
  '输入：翻译产物目录里的 LabelPlus txt（>>>>>>>>[文件名]<<<<<<<< 分块，----[n]----[x,y,类型] 为标签）',
  '输出：每话一个 data/text/<series>/<chapter>.json，坐标 0–1，t 原文、tn 归一化文本',
  '解析器与归一化在 @gallery/core（第 2 步）落地后接入；CHAPTERS 环境变量限定要处理的话',
]);
