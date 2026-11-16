---
layout: page
sidebar: false
title: API 与组件参考
description: Pagehaven 单一配置源、@gallery/core / @gallery/search Web 标准 API、阅读器深链与备份 Schema，以及三阶段发布 CLI 参考（APIFox 风格交互视图）。
---

<script setup lang="ts">
import { apiSpecZh } from '../.vitepress/data/api-spec'
</script>

<ApiExplorer :spec="apiSpecZh">

### 单一配置源 site.config.yaml (`parseSiteConfig`) {#schema-site-config}

校验站点域名、图片 CDN 主机、SQLite 分块与页大小一致性，以及四端静态预算上限。

### 作品与章节元数据 Schema (`parseSeriesMeta`) {#schema-meta-yaml}

校验 `data/meta/*.yaml` 中小写连字符 ID、连续页码 `n` 与 12 位图片 SHA-256 前缀 `img`。

### 坐标化台词层 ChapterTextSchema (`parseChapterText`) {#schema-text-layer}

校验 `data/text/*.json` 的 `[0, 1]` 归一化坐标与逐句台词文本。

### 文本归一化与混合台词检索 (`normalizeText` / `queryLines`) {#core-search-query}

五步幂等归一化配合 `<2` 字拒绝、`2` 字 `LIKE` 与 `>=3` 字 `FTS5 trigram MATCH`，返回 `#p<n>b<i>` 结果。

### 版本锁定与校验检索库加载 (`loadGalleryDb`) {#core-load-db}

优先命中站点固定版本的 `gallery-*.sqlite`，流式限长默认 `30 MiB` 并校验 SHA-256。

### 多源 HTTP Range 分块层 (`@gallery/core/chunkfetch`) {#core-chunkfetch}

支持 `HEAD`/`Range` 探测、`SourceSet` EMA 选源与 `64 KiB` 逐块 SHA-256 校验（当前未接入浏览器 VFS）。

### 阅读器深链与渐进增强 (`#p<n>b<i>` / `mountEnhancedReader`) {#reader-hash-and-modes}

每话单 HTML 无脚本可读，支持长条二分定位、100 话分片目录与可选 Comimi 增强分页。

### 本地书架与阅读进度备份 Schema (`parseReadingBackup`) {#reader-backup-schema}

`pagehaven-reading-backup` v1 JSON 严格白名单导入，限制 `5 MiB` 与 `20,000` 条记录。

### 全量构建与预算合规检查 CLI (`pnpm run build` / `check`) {#ops-build-and-check}

串联构建模板、SQLite 建库与 Astro 编译，按 `TARGET_CAPABILITIES` 守卫发布预算。

### R2 不可变上传与条件指针切换 CLI (`publish:r2` / `release:activate`) {#ops-release-pipeline}

上传私有 R2、校验各目标随机 HTTPS 证明文件，并以 `If-Match` 原子激活 `manifest.json`。

</ApiExplorer>
