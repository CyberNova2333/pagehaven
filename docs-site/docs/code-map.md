# 源码地图与贡献工作流

本页提供工作区结构定位、独立文档站热更新机制、CI 门禁以及本地 Git 钩子约束概览；深入调查台账见仓库内 `repo-docs/code-map.md`。

## 仓库目录总览

| 目录 / 文件 | 核心职责 | 说明与代表文件 |
| --- | --- | --- |
| `packages/core/` | Web 标准领域模型、归一化、SQLite 建库与分块校验 | `src/schema.js`、`src/normalize.js`、`src/labelplus.js`、`src/object-path.js`、`src/db/`、`src/chunkfetch/` |
| `packages/platform/` | 配置校验、5 目标能力注册与托管规则生成 | `src/site-config.js`、`src/targets.js`、`src/deploy-name.js`、`src/generators/`、`generated/` |
| `packages/search/` | 浏览器端检索库加载与台词查询接线 | `src/load.js`、`src/query.js`、`src/mount.js` |
| `packages/site/` | Astro 7.4 静态漫画站、阅读器与本地书架 | `astro.config.mjs`、`src/layouts/Base.astro`、`src/pages/`、`src/lib/`、`public/` |
| `scripts/` | 构建编排、校验检查、导入与多端发布脚本 | `build-*.mjs`、`check.mjs`、`check-data.mjs`、`init-site.mjs`、`customize.mjs`、`ingest-*.mjs`、`publish-r2.mjs`、`deploy.mjs`、`release.mjs`、`seo-push.mjs`、`docs-dev.mjs`、`ci/{git-signing,release-writeback}.mjs` |
| `scripts/lib/` | 纯逻辑单测模块与 CI 策略校验 | `manifest.mjs`、`deploy-plan.mjs`、`deploy-budget.mjs`、`deploy-proof.mjs`、`deploy-ready.mjs`、`github-pages-publish.mjs`、`fetch-signal.mjs`、`redact.mjs`、`pipeline-policy.mjs`、`readme-links.mjs`、`static-output.mjs`、`pnpm-runner.mjs` |
| `data/` | 漫画元数据、台词层与原始翻译/OCR 稿（模板默认空） | `meta/`、`text/`、`raw/labelplus/`、`raw/ocr/` |
| `docs/` | 仓库硬引用核心架构归档 | `docs/ARCHITECTURE.md`（由 `check.mjs` 与 `placeholder.mjs` 强引用，必须保留） |
| `docs-site/` | 独立安装的双语 VitePress 文档站 | `.vitepress/config.mts`、`docs/`、`en/docs/`、`public/diagrams/` |
| `repo-docs/` | 面向协作者与审计的 Standard 级工程源码指南 | `README.md`、`walkthroughs/one-real-run.md`、`code-map.md`、`modules/`、`glossary.md`、`references/`、`change-log.md` |
| `tools/` & `guardrails/` | Git 钩子、维护守卫、分支清理与校验分级脚本 | `tools/githooks/{commit_msg.py,pre_push.py,_generated.py,_msgrules.py}`、`tools/github_repo.py`、`tools/install_hooks.py`、`tools/repo_maintenance_guard.py`、`tools/verification-tier.py` |

## 独立文档站开发与索引机制

`docs-site/` 故意使用独立的 `package.json` 与 `pnpm-lock.yaml`，防止 VitePress 及其传递依赖混入业务产物审计。

- **静态测试 (`pnpm run test:docs`)**：
  1. `scripts/test/docs-site.test.mjs` 把 `docs-site/` 构建到系统临时目录，校验全部中英文页面均含 `<h1>`、无未解析的 `@include`、全部站内链接与 `#锚点` 真实可达，并加载同次生成的 MiniSearch 索引，验证双语搜索互不串扰；
  2. `scripts/test/docs-workflow.test.mjs` 离线审计 `.github/workflows/checks.yml` 与 `docs-pages.yml`，确认文档依赖安装、moderate 审计与统一测试不可条件跳过或吞错，且文档部署仅允许手动触发；
  3. `scripts/test/docs-dev.test.mjs` 启动真实开发服务器，测试保存 Markdown 后自动重启刷新与搜索索引缓存版本号轮换。
- **本地开发 (`pnpm --dir docs-site run docs:dev`)**：由 `scripts/docs-dev.mjs` 与 `docs-site/.vitepress/guide-search-refresh.mjs` 协同驱动，保存文档 Markdown 后会触发服务重建索引并递增缓存版本，防止浏览器滞留旧搜索结果。

## 贡献与 CI 门禁分级

项目采用以 `main` 为主干的 Trunk-Based 工作流（见仓库 `CONTRIBUTING.md`）：

- **Commit 与 Push 钩子**：
  - 提交标题需遵守 `<type>(<scope>): <含中文摘要>` 且总长 ≤ 100 字符；
  - 提交正文须包含 `文档:`（或 `文档：`）说明及 `Co-authored-by: <Name> <email>` 署名；
  - `pre-commit` 与 `pre-push`（`tools/repo_maintenance_guard.py`）扫描暂存区私密凭据、大文件与路径合规性。
- **GitHub Actions 流水线校验**：
  - `.github/workflows/checks.yml` 在 `main` 推送与手动调度时依次冻结安装业务与文档依赖、执行 `pnpm --dir docs-site audit --audit-level=moderate` 并运行完整 `pnpm test` 与 `pnpm run check`；
  - `scripts/lib/pipeline-policy.mjs` 直接审计 `.github/workflows/{checks,release,archive,docs-pages}.yml`，禁止把任何自动部署命令塞入常规推送阶段，确保所有生产发布与文档部署只能由显式手动触发启动。

## 四级本地验证矩阵

| 改动类型 | 建议执行命令 |
| --- | --- |
| 纯文档或 README 更新 | `pnpm run check`、`pnpm --dir docs-site run docs:build`、`pnpm run test:docs`（配合 `validate_repo_docs.py`） |
| 脚本 / 数据模型 / 检索核心改动 | `pnpm test` 与 `pnpm run check` |
| 站点页面 / 外观 / 构建链路改动 | `pnpm run build`、`pnpm run check`、`pnpm test` |
| 平台配置 / 发布脚本 / 预算逻辑改动 | `DEPLOY_TARGET=all pnpm run check`、`pnpm test`，并按 `CONTRIBUTING.md` 对受影响平台完成 `DEPLOY_ENV=preview` 真实部署确认 |
