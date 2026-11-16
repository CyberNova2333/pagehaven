---
layout: home

hero:
  name: 页间 · Pagehaven
  text: 纯静态漫画库与台词检索引擎
  tagline: 基于 Astro 静态输出、SQLite Wasm 全文索引与 R2 + CDN 分发的可持续数字漫画出版基础设施。
  actions:
    - theme: brand
      text: 起步与部署
      link: /docs/
    - theme: alt
      text: API 与组件参考
      link: /api-reference/
    - theme: alt
      text: 契约与边界
      link: /docs/boundaries
    - theme: alt
      text: 架构与内核
      link: /docs/architecture

features:
  - title: 每话单 HTML 与四端便携
    details: 遵守 EdgeOne、ESA（2,000 文件上限）、GitHub Pages 与 Workers 免费静态基线，无脚本时照样可读全部图文。
  - title: 浏览器端 SQLite Wasm 检索
    details: 构建期生成 FTS5 trigram 数据库与分块清单，查询经 OpenCC 繁简归一并精确跳转到 #p<n>b<i> 气泡坐标。
  - title: 私有 R2 与三阶段不可变发布
    details: 静态 HTML 与 WebP/DB 读写分离，上传、随机证明核对与 ETag 条件启用严格隔离，杜绝半截上线。
---

## 能力定位与明确边界

::: info 能做到什么程度（已实现能力）
- **零后端纯静态托管与多端发布**：一套 `site.config.yaml` 单一配置源驱动 Astro 7.4 生成每话单 HTML，统一适配 EdgeOne、阿里云 ESA Pages（≤ 1,999 业务文件）、GitHub Pages 与 Cloudflare Workers，并通过 R2 私有上传 + 随机部署证明 + `If-Match` 原子切换 `manifest.json`。
- **浏览器端全文检索与渐进阅读**：`normalizeText`（5 步幂等 NFKC + 去标点 + OpenCC 繁转简 + 小写）配合 `FTS5 trigram` / `LIKE` 精确跳转到 `#p<n>b<i>` 台词气泡；阅读器支持单页、条漫（对数二分定位）、双页、100 话分片目录与可选 Comimi 增强分页。
- **本地书架与 5 MiB 白名单迁移**：阅读进度、想看/在看/已读状态与 200 字页码笔记全存本地 `localStorage`，支持 `pagehaven-reading-backup` Schema 严格校验导出与恢复。
:::

::: warning 明确不能做什么（非目标与硬限制）
- **无用户系统与动态后台**：不提供账号注册登录、评论区、Web 后台在线传图或 SSR 常驻服务进程；个人书架与笔记仅保存在浏览器本地。
- **检索库与托管规模硬约束**：浏览器端台词检索默认限 `db.whole_download_max_bytes`（`30 MiB`）以内，`normalizeText` 后不足 `2` 字直接拒绝下载与查询；`@gallery/core/chunkfetch` 已实现 HTTP Range 取块原语，尚未接入浏览器端 SQLite VFS。
- **平台预算与人工审核底线**：ESA 部署硬上限 `2,000` 文件 / `1,024,000,000 B`；未经过 `--accept-reviewed` 确认的 `ingest:ocr` 草稿绝不自动进入正式检索库；禁止将 R2 / Cloudflare / ESA 凭据写入配置或前端代码。
:::

## 核心管线交互全景图

<DiagramFrame
  src="/diagrams/pagehaven-pipeline.html"
  title="Pagehaven 核心管线：01 原始稿件 → 02 规范化 IR → 03 发布产物 → 04 阅读引擎（支持缩放与平移探查）"
  aspect="720 / 652"
  new-tab-label="在新窗口全屏打开 ↗"
/>

## 10 秒本地验证

仓库默认以空白通用模板起步，可直接运行一次真实静态构建与检查：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm --filter @gallery/site run preview
# 默认在 http://localhost:4321 预览；加载内置样本数据可设 DATA_DIR=packages/core/test/fixtures/data
```

## 文档分层导航

::: tip 按照读者需求快速跳转
- **站点维护者 / 部署运维**：从 [项目概览与快速上手](/docs/) → [多模式运行与多平台部署](/docs/deployment) 起步，排查报错见 [部署排错 FAQ](/docs/faq)；
- **逐项查 Schema、SDK 与发布 CLI**：进入 [API 与组件参考（三栏式交互视图）](/api-reference/)，或查阅 [配置、数据与前端契约](/docs/configuration) 与 [能力边界与安全假设](/docs/boundaries)；
- **阅读器 / 检索与架构审计**：查阅 [核心子系统与架构全景](/docs/architecture)、[一次真实构建演练](/docs/walkthrough) 与 [源码地图](/docs/code-map)；
- **历史演进与变更决策**：参阅 [版本变更、迁移与决策记录](/docs/changelog) 及仓库内 `repo-docs/README.md`。
:::
