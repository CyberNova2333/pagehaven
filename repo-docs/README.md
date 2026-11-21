# 页间 · Pagehaven 源码阅读指南

维护者更新作品元数据与台词稿后，希望构建并在多个免费边缘托管平台上安全发布静态漫画阅读站。本指南采用 **Standard 模式**，从一次真实构建交接出发，完整覆盖配置目标、数据模型与归一化、浏览器端 SQLite Wasm 检索、Astro 静态阅读器以及 R2 原子发布与证明闭环。

## 阅读路径

| 读者目标 | 从这里开始 | 读完后获得什么 |
| --- | --- | --- |
| 理解一次真实构建与发布 | [一次真实主流程](walkthroughs/one-real-run.md) | 掌握配置、清单、建库、编译与四端证明交接的完整顺序与拒绝边界 |
| 按职责快速定位源码 | [代码地图](code-map.md) | 在声明范围与排除边界内准确找到包入口、关键符号与验证文件 |
| 理解配置与目标能力契约 | [配置与目标模块](modules/site-config-and-targets.md) | 掌握 `site.config.yaml` SSOT、`GENERATED_FILES` 与五目标上限差异 |
| 理解作品模型与文本处理 | [数据模型与归一化模块](modules/data-model-and-normalization.md) | 掌握 `Series/Issue/Chapter` schema、LabelPlus/OCR 门禁与五步 `normalizeText` |
| 理解浏览器检索与分块层 | [检索与分块模块](modules/search-db-and-chunkfetch.md) | 掌握 `FTS5 trigram` / `LIKE` 混合查询、30 MiB 下载守卫与 `chunkfetch` 边界 |
| 理解阅读器、书架与备份 | [阅读器与书架模块](modules/static-reader-and-bookmarks.md) | 掌握无脚本阅读、100 话目录分页、条漫二分定位、Comimi 回退与 5 MiB 备份 |
| 理解 R2 发布与随机证明 | [发布流水线与部署证明模块](modules/release-pipeline-and-proofs.md) | 掌握三阶段原子启用、ESA/Workers 证明预留与 CI/钩子安全守卫 |
| 查阅领域术语与约定 | [术语表](glossary.md) | 对齐 `sourceSha256`、`#p<n>b<i>`、随机证明与各类硬上限的准确含义 |
| 审核源码证据与质量复核 | [源码证据](references/source-evidence.md) · [质量复核](references/quality-review.md) | 核对两遍调查台账、反证条件与读者模拟覆盖度 |
| 查看同步锚点与命令实录 | [指南变更记录](change-log.md) | 核对各次源码同步基准、实际执行命令及测试结果 |

## 覆盖范围

本包已覆盖 `packages/core/src/`、`packages/platform/src/`、`packages/search/src/`、`packages/site/src/`、`scripts/`（含 `scripts/lib/` 与 `scripts/ci/`）、`docs-site/` 及 `tools/`（githooks 与维护守卫）。以下目录仅作边界说明而不逐行展开内部实现或产物：`node_modules/`、`dist/`、`out/`、`packages/site/src/generated/`、样本夹具与占位资产、`.claude/`、`.codex/` 与 `guardrails/` 细则文件。本地验证通过不等于已线上发布或已完成所有云端平台实际部署验收。

## 运行与验证入口

在仓库根目录执行以下命令。默认构建会更新 `packages/site/src/generated/`、`dist/` 和 `out/`。需要保留当前预览时，为构建和检查设置同一个独占 `BUILD_WORK_DIR`。站点集成测试和本地样站会自动创建临时目录。

```sh
pnpm install --frozen-lockfile
pnpm --dir docs-site install --frozen-lockfile
pnpm exec playwright install --with-deps --only-shell chromium
pnpm run build
pnpm run check
pnpm test
```

## 文档构建依赖边界

官网与面向用户的文档站维护在独立子项目 [docs-site/](../docs-site/index.md) 对应的 [文档配置](../docs-site/.vitepress/config.mts)（`docs-site/package.json` 精确锁定 `vitepress@2.0.0-alpha.21` 与 `vue@3.5.44`，根工作区安装与审计不覆盖它）。更新文档后须单独安装依赖并通过审计：

```sh
pnpm --dir docs-site install --frozen-lockfile
pnpm --dir docs-site audit --audit-level=moderate
pnpm --dir docs-site run docs:build
pnpm run test:docs
```

开发模式通过 `pnpm --dir docs-site run docs:dev`（[开发启动器](../scripts/docs-dev.mjs) + [搜索刷新插件](../docs-site/.vitepress/guide-search-refresh.mjs)）支持中英文 Markdown 保存后重建索引与缓存版本号轮换；静态构建则由 `docs-site/.vitepress/config.mts` 保持纯本地生成，不引入外部服务或 `repo-docs/` 自动直连，防止发布官网产物暴露仓库源码相对路径。CI 检查在 `.github/workflows/checks.yml` 强制上述安装、审计与测试顺序；官网部署（`.github/workflows/docs-pages.yml`）仅保留手动触发。

## 既有权威专题

- [数据模型、平台约束与历史决策](../docs/ARCHITECTURE.md)（仓库硬引用架构基线）
- [前端视觉令牌与双模式设计说明](../DESIGN.md)

证据状态：除特别标注外，本页基于当前源码已确认。
