# 页间 · Pagehaven 代码地图

先读[一次真实主流程](walkthroughs/one-real-run.md)建立端到端模型，再按职责定位模块入口、符号与验证脚本。

| 路径 | 职责 | 关键代码 | 与主流程的关系 |
| --- | --- | --- | --- |
| `packages/core/src/` | 数据 schema、文本归一化、LabelPlus 解析、SQLite Wasm 建库与 Range 取块 | `packages/core/src/schema.js`、`packages/core/src/normalize.js`、`packages/core/src/db/build.js`、`packages/core/src/chunkfetch/chunked-file.js` | 执行格式校验、归一化并构造检索库 |
| `packages/platform/src/` | 配置源 Zod 校验、五目标注册与公共/部署模板生成 | `packages/platform/src/site-config.js`、`packages/platform/src/targets.js`、`packages/platform/src/index.js` | 生成平台规则、部署控制模板并检查同步 |
| `packages/search/src/` | 浏览器端检索库懒加载、流式 SHA-256 校验、MATCH/LIKE 查询与页面挂载 | `packages/search/src/load.js`、`packages/search/src/query.js`、`packages/search/src/mount.js` | 读取固定构建库并在浏览器执行查询 |
| `packages/site/src/` | Astro 7.4 静态编译、外观变量、阅读器、目录分页与书架备份 | `packages/site/src/layouts/Base.astro`、`packages/site/src/lib/site-appearance.js`、`packages/site/src/lib/reading-backup.js` | 编译每话静态阅读页、搜索页、书架页与索引入口 |
| `scripts/` | 初始化、台词导入、构建串联、静态检查、R2 上传与多端部署（含 `scripts/lib/`、`scripts/ci/`、`tools/`） | `scripts/build-site.mjs`、`scripts/check.mjs`、`scripts/deploy.mjs`、`scripts/lib/manifest.mjs`、`scripts/ci/release-writeback.mjs` | 根命令构建编排、预算证明检查与发布入口 |
| `docs-site/` | 独立锁定 VitePress 双语文档站与本地搜索刷新插件 | `docs-site/.vitepress/config.mts`、`docs-site/.vitepress/guide-search-refresh.mjs` | 面向读者与维护者的双语使用文档与交互管线图 |

## `packages/core/src/`

源码禁止导入 `node:*` 模块，确保构建期与浏览器端运行同一套校验、归一化与检索库逻辑；机制详见[数据模型与归一化模块](modules/data-model-and-normalization.md)与[检索与分块模块](modules/search-db-and-chunkfetch.md)。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [数据结构与模型](../packages/core/src/schema.js) | 校验 Series / Issue / Chapter / Page / ChapterText（0–1 坐标框） | `SeriesSchema / IssueSchema / parseChapterText` | 数据检查、台词导入、清单构建 |
| [台词归一化](../packages/core/src/normalize.js) | 五步幂等归一化，剔除空白标点并透传 `Cn` | `normalizeText / STRIP_RE` | 检索建库与 `@gallery/search` |
| [LabelPlus 解析](../packages/core/src/labelplus.js) | 精确分隔符解析与 1 起行号可疑行告警 | `parseLabelPlus / labelPlusToChapterText` | LabelPlus 导入入口 |
| [路径校验](../packages/core/src/object-path.js) | 约束纯 ASCII 相对前缀与对象 key | `isSafeObjectPrefix / isSafeObjectKey` | 平台配置、发布计划、浏览器加载器 |
| [检索库构建](../packages/core/src/db/build.js) | 建表、事务插入、`lines_fts rebuild`、`journal_mode=DELETE` 与 `VACUUM` | `buildGalleryDb / openGalleryDb / SCHEMA_SQL` | 检索建库与搜索单测 |
| [分块摘要](../packages/core/src/db/chunks.js) | 调用 `crypto.subtle` 计算整库与 64 KiB 分块 SHA-256 | `computeChunkManifest / sha256Hex` | 检索建库与取块校验 |
| [Range 分块](../packages/core/src/chunkfetch/chunked-file.js) | Range 探测、并发去重、EMA 选源、块校验与 `needs-whole` 信号 | `ChunkedFile / DEFAULT_RETRY` | 独立单测（暂未接入在线 SQLite VFS） |

验证入口：`packages/core/test/`（`schema`、`model`、`normalize`、`labelplus`、`db`、`chunkfetch`）与 `scripts/test/object-prefix.test.mjs`。

## `packages/platform/src/`

负责解析 `site.config.yaml`、声明五目标能力以及区分公开产物与部署控制模板；详见[配置与目标模块](modules/site-config-and-targets.md)。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [配置校验](../packages/platform/src/site-config.js) | 校验站点、外观、图源、DB、搜索、功能开关与部署配置 | `parseSiteConfig` | 配置生成、初始化与静态检查 |
| [目标能力注册](../packages/platform/src/targets.js) | 区分四端默认集合与 `cloudflare`，声明文件/字节上限 | `DEPLOY_TARGETS / DEFAULT_RELEASE_TARGETS / TARGET_CAPABILITIES` | 发布计划、预算检查、初始化 |
| [部署名校验](../packages/platform/src/deploy-name.js) | 约束 Workers 与 ESA 项目名称格式 | `isDeploymentName` | 部署计划与配置生成器 |
| [生成物入口与模板](../packages/platform/src/index.js) | 区分进 `dist` 的 `GENERATED_FILES` 与不进 `dist` 的 `DEPLOY_CONFIG_FILES` | `GENERATED_FILES / DEPLOY_CONFIG_FILES / generateAll` | 配置生成、站点构建与静态检查 |

验证入口：`packages/platform/test/site-config.test.js`、`packages/platform/test/deployment-config.test.js`、`packages/platform/test/deploy-name.test.js`。

## `packages/search/src/`

负责在浏览器端懒加载固定构建版本的检索数据库、校验流长度与摘要并执行混合查询；详见[检索与分块模块](modules/search-db-and-chunkfetch.md)。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [检索库加载](../packages/search/src/load.js) | 读取 `db.release`、按字节上限中止流并核对 SHA-256 | `loadGalleryDb / FETCH_TIMEOUT_MS / DEFAULT_WHOLE_DOWNLOAD_MAX_BYTES` | 搜索挂载入口 |
| [查询调度](../packages/search/src/query.js) | `<2` 拒绝、`===2` LIKE 降级、`>=3` FTS5 短语 `MATCH` 与 `#p<n>b<i>` 结果拼装 | `prepareQuery / queryLines / RESULT_LIMIT` | 搜索挂载入口 |
| [页面挂载](../packages/search/src/mount.js) | 检查 `coverage` 与 DOM 节点，无文本时零网络请求 | `mountSearch` | 站点搜索页脚本 |

验证入口：`packages/search/test/search.test.js`、`packages/search/test/empty-state.test.js`、`packages/site/test/search-page.test.js`。

## `packages/site/src/`

使用 Astro 7.4.12 输出纯静态页面、内联外观与渐进交互；详见[阅读器与书架模块](modules/static-reader-and-bookmarks.md)。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [Astro 构建配置](../packages/site/astro.config.mjs) | 静态输出、内联样式与 noop 图像服务（剔除 `sharp`） | `defineConfig` | 站点构建脚本 |
| [共享外壳布局](../packages/site/src/layouts/Base.astro) | 内联首屏配色、本地 `IBM Plex Sans` 字体、`noindex` 与动效接入 | `paletteCSS / colorSchemeScript` | 站内各页面 |
| [外观与三态配色](../packages/site/src/lib/site-appearance.js) | 计算 `paper/ocean/plum` 变量与对比度；[color-scheme.js](../packages/site/src/lib/color-scheme.js) 同步三态切换 | `appearanceVariables / initializeColorScheme` | 共享布局与昼夜场景接线 |
| [每话单 HTML 阅读器](../packages/site/src/pages/[series]/[issue]/[chapter]/index.astro) | 无 JS 静态流 + 内联核心切换阅读模式与 `#p<n>b<i>` 高亮；配合 [chapter-toc.js](../packages/site/src/lib/chapter-toc.js) 与 [enhanced-reader.js](../packages/site/src/lib/enhanced-reader.js) | `getStaticPaths / mountChapterToc / mountEnhancedReader` | 站点构建与检索直达跳转 |
| [书架与备份迁移](../packages/site/src/lib/reading-backup.js) | `pagehaven-reading-backup` v1 导出与 5 MiB / 20k 条上限校验导入 | `parseReadingBackup / MAX_BACKUP_BYTES / MAX_BACKUP_RECORDS` | 书架页与阅读状态迁移 |

验证入口：`packages/site/test/` 与 `scripts/test/site-build.test.mjs`。

## `scripts/`

串联维护者命令行入口、构建步骤、台词导入、静态检查与发布编排（含 `scripts/lib/`、`scripts/ci/` 与 `tools/` 维护脚本）。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [初始化与可视化改色](../scripts/init-site.mjs) | 命令行双语改配置；[customize.mjs](../scripts/customize.mjs) 启动令牌保护配置器 | `main / parseInitArgs` | 维护者本地初始化与调色 |
| [台词导入入口](../scripts/ingest-labelplus.mjs) | 导入 LabelPlus 原稿；[ingest-ocr.mjs](../scripts/ingest-ocr.mjs) 输出 OCR 草稿与 `--accept-reviewed` 导入 | `ingestLabelPlus / ingestOcr` | 内容编辑与发布流水线 |
| [清单、建库与站点构建](../scripts/build-manifest.mjs) | 清单（[build-manifest.mjs](../scripts/build-manifest.mjs)）→ 建库（[build-db.mjs](../scripts/build-db.mjs)）→ 站点（[build-site.mjs](../scripts/build-site.mjs)）→ 索引与 sitemap | `buildManifest / resolveVersion / galleryFingerprint` | `pnpm run build` 主流程 |
| [静态检查入口](../scripts/check.mjs) | 核对配置同步、Web 标准边界、无 `sharp`、README 锚点、CI 策略与四端预算 | `checkDocumentationPipelines / checkReadmeLinks` | 维护验证与 CI 检查 |
| [部署、发布与证明](../scripts/deploy.mjs) | 隔离证明副本部署与签名 `gh-pages` 推送（[github-pages-publish.mjs](../scripts/lib/github-pages-publish.mjs)）；联合 [publish-r2.mjs](../scripts/publish-r2.mjs)、[release.mjs](../scripts/lib/release.mjs)、[deploy-budget.mjs](../scripts/lib/deploy-budget.mjs) 与 [deploy-ready.mjs](../scripts/lib/deploy-ready.mjs) 执行条件启用 | `recordDeployment / prepareRelease / activateRelease / pushGithubPages` | 手动发布流水线 |
| [签名写回与 Git 钩子](../scripts/ci/git-signing.mjs) | 配合 [release-writeback.mjs](../scripts/ci/release-writeback.mjs) 执行临时 Ed25519 SSH 签名写回，配合 [commit_msg.py](../tools/githooks/commit_msg.py)、[pre_push.py](../tools/githooks/pre_push.py)、[_generated.py](../tools/githooks/_generated.py) 与 [repo_maintenance_guard.py](../tools/repo_maintenance_guard.py) 守卫提交及推送 | `withGithubSigning / writeReleaseChanges / validate_commit_message / check_staged_changes` | 发布作业与 Git 本地钩子 |

- `scripts/lib/` 另包含 [deploy-plan.mjs](../scripts/lib/deploy-plan.mjs)、[pnpm-runner.mjs](../scripts/lib/pnpm-runner.mjs)、[deploy-proof.mjs](../scripts/lib/deploy-proof.mjs)、[fetch-signal.mjs](../scripts/lib/fetch-signal.mjs)、[redact.mjs](../scripts/lib/redact.mjs)、[static-output.mjs](../scripts/lib/static-output.mjs)、[readme-links.mjs](../scripts/lib/readme-links.mjs)、[seo-push.mjs](../scripts/lib/seo-push.mjs) 与 [pipeline-policy.mjs](../scripts/lib/pipeline-policy.mjs)，覆盖清单见[发布流水线与部署证明模块](modules/release-pipeline-and-proofs.md)。
- `.github/scripts/sync_assets_licenses.py` 由 `checks.yml` 执行只读门禁，核对 `ASSETS_LICENSES.md` 人类与 AI 工具清单同步。
- `tools/` 另包含 [_msgrules.py](../tools/githooks/_msgrules.py)、[_generated.py](../tools/githooks/_generated.py)、[github_repo.py](../tools/github_repo.py)、[install_hooks.py](../tools/install_hooks.py)、[agent-guard.py](../tools/agent-guard.py) 与 [verification-tier.py](../tools/verification-tier.py)，测试入口为 `tools/test/test_*.py`（含 `test_pre_push.py`、`test_github_repo.py`、`test_generated_commit.py`、`test_install_hooks.py`、`test_agent_guard.py`）。

验证入口：`scripts/test/`（含 `docs-site.test.mjs`、`docs-workflow.test.mjs`、`docs-dev.test.mjs`、`github-pages-publish.test.mjs`、`release-writeback.test.mjs`、`pre-push.test.mjs`、`seo-push.test.mjs`、`pipeline-policy.test.mjs` 等）。

## `docs-site/`

独立锁定 VitePress `2.0.0-alpha.21` 与 Vite 8 的双语官方文档站，隔离文档依赖以免影响业务依赖审计。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [双语文档配置](../docs-site/.vitepress/config.mts) | 定义 Tier A 四阶段中文与同步英文导航、本地搜索隔离及刷新插件接线 | `defineConfig / guideSearchRefresh` | 文档站静态构建与开发服务 |
| [开发搜索刷新插件](../docs-site/.vitepress/guide-search-refresh.mjs) | 协同 [开发启动器](../scripts/docs-dev.mjs) 在 Markdown 保存后重启服务并轮换索引缓存版本 | `guideSearchRefresh / startDocsDev` | 文档开发模式与热更新测试 |

验证入口：`scripts/test/docs-site.test.mjs`、`scripts/test/docs-dev.test.mjs`、`scripts/test/docs-workflow.test.mjs`。

## 覆盖范围

本代码地图与 Standard 级模块指南已覆盖仓库第一方业务包、构建发布脚本、独立文档站与 Git 维护工具：`packages/core/src/`、`packages/platform/src/`、`packages/search/src/`、`packages/site/src/`、`scripts/`（含 `scripts/lib/`、`scripts/ci/`）、`docs-site/`、`docs/ARCHITECTURE.md`、`DESIGN.md` 与 `tools/`。

下列目录属于生成产物、运行缓存、外部依赖、占位示例或本地护栏配置，明确排除在逐模块拆解之外：`node_modules/`、`dist/`、`out/`、`packages/site/src/generated/`、`data/` 占位说明与测试夹具二进制资产、`.claude/`、`.codex/` 与 `guardrails/`。工作区安装链接与 `astro>sharp: '-'` 覆盖另由 [pnpm 工作区配置](../pnpm-workspace.yaml) 与 [workspace.test.mjs](../scripts/test/workspace.test.mjs) 守护。

证据状态：除特别标注外，本页基于当前源码已确认。
