#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ingest:ocr —— 缺稿卷 OCR → data/text（只在 GitHub Actions 里跑；ARCHITECTURE §1、§4）。

占位：OCR 只补没有 LabelPlus 稿的话，输出与 ingest:labelplus 同一 schema。
落地时的原则：自己汉化的成品不再 OCR 一遍；OCR 引擎（BallonsOCR / PaddleOCR）
的输出统一转成 data/text 的 JSON，再走同一条 tn 归一化。
"""
import sys

print("⚠ ingest:ocr：占位，尚未实现（docs/ARCHITECTURE.md §10）")
print("  只在 release.yml 的 ocr=true 时调用；本地与 Makers 构建机都不跑（那里没有 Python）")
sys.exit(0)
