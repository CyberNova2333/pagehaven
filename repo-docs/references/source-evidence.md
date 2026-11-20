# 页间 · Pagehaven 源码证据

本页为本指南（Standard 模式）的调查台账：记录第一遍行为建模、第二遍反查与模块深化覆盖到的源码文件、直接证据、可信度及未执行实测边界。最近同步锚点为 Commit `07bbc3e`（升级 Astro 至 `7.4.12` 并重整双语文档站及 Standard 级工程指南）。

## Evidence Traversal Log

| Pass | Purpose | Inspected evidence | What changed in the model |
| --- | --- | --- | --- |
| Pass 1（初次主流程） | 建立构建与发布交接路径 | `scripts/build-manifest.mjs`、`scripts/build-db.mjs`、`scripts/build-site.mjs`、`packages/platform/src/`、`README.md` | 固定 manifest/DB/site 同一版本与 `sourceSha256` 交接边界及纯静态基线。 |
| Pass 2（初次反查） | 核对失败分支、四端预算与证明 | `scripts/lib/{deploy-budget,deploy-proof,deploy-ready,release,pipeline-policy,pnpm-runner,static-output}.mjs`、`scripts/deploy.mjs`、`scripts/check.mjs` | 证实 ESA 2,000 上限扣除 1 证明文件为 1,999、Workers 为 17,999、随机证明防伪与 `If-Match` 原子切换。 |
| Pass 3（Standard 深化一：核心数据与检索） | 覆盖 `@gallery/core` 与 `@gallery/search` 实现与边界 | `packages/core/src/{schema,model,normalize,labelplus,object-path}.js`、`packages/core/src/db/{build,chunks}.js`、`packages/core/src/chunkfetch/chunked-file.js`、`packages/search/src/{load,query,mount}.js` | 确认 5 步幂等 `normalizeText` 排除 `Cn` 码位、`>=3` MATCH / `2` LIKE / `<2` 拒绝、30 MiB 流式限长校验，以及 `chunkfetch` 已实现但尚未接入 SQLite VFS。 |
| Pass 4（Standard 深化二：阅读器、外观与导入/SEO） | 覆盖 `@gallery/site` 交互、备份、`ingest-*`、`init/customize` 与 CI | `packages/site/astro.config.mjs`、`packages/site/src/layouts/Base.astro`、`packages/site/src/lib/{site-appearance,reading-backup,enhanced-reader}.js`、`packages/site/src/pages/{search,library,[series]/[issue]/[chapter]}/index.astro`、`scripts/{ingest-labelplus,ingest-ocr,customize}.mjs`、`scripts/lib/{init-site,seo-push,readme-links}.mjs` | 确认 `paper/ocean/plum` 品牌蓝主题与本地 `IBM Plex Sans`、`pagehaven-reading-backup` 5 MiB/20k 白名单、`ingest:ocr` 人工校对门禁、Comimi 回退及 IndexNow 差集推送。 |
| Pass 5（文档站与钩子核对） | 审计 `docs-site/` 与工作区/钩子依赖边界 | `docs-site/{package.json,.vitepress/config.mts,.vitepress/theme/i18n.ts,public/diagrams/*.html}`、`scripts/test/{docs-site,docs-dev,docs-workflow}.test.mjs`、`tools/githooks/{commit_msg.py,_msgrules.py}` | 确认旧文档站存在脱离仓库实现的占位文本，`docs-dev.test.mjs` 仅复制 `config.mts` 与 `guide-search-refresh.mjs`；核准 `pagehaven-pipeline.html` 对齐真实管线而 `pagehaven-architecture.html` 属历史草图保留资产。 |
| Pass 6（GitHub 单一工作流与签名发布链） | 核对去 CNB 化工作流守卫、临时 SSH 签名发布写回与本地只读护栏 | `.github/workflows/*.yml`、`scripts/lib/{pipeline-policy,github-pages-publish,readme-links,release}.mjs`、`scripts/ci/{run-with-secrets,git-signing,release-writeback}.mjs`、`tools/{github_repo,install_hooks,agent-guard}.py`、`tools/githooks/{pre_push,_generated}.py` | 确认 `pipeline-policy.mjs` 直接审计 `.github/workflows/*.yml`、`release.yml` 强制核对 `last-green == GITHUB_SHA`、签名写回使用 `Generated-by: Pagehaven release` 窄例外且禁绝控制变量注入与覆盖既有本地钩子。 |

## 证据表

| Claim | Evidence | Confidence | Caveat | Used by |
| --- | --- | --- | --- | --- |
| 配置与清单用 `sourceSha256`、`version` 与域名锁死绑定关系 | [build-manifest.mjs](../../scripts/build-manifest.mjs)、[build-db.mjs](../../scripts/build-db.mjs)、[build-site.mjs](../../scripts/build-site.mjs)：`galleryFingerprint / resolveVersion` | Confirmed | 若跨不同 `DATA_DIR` / `OUT_DIR` 覆盖，需同次重跑全量构建 | [主流程](../walkthroughs/one-real-run.md)、[发布流水线模块](../modules/release-pipeline-and-proofs.md) |
| 核心与前端包严禁 `node:*`、禁 `sharp`，静态基线关闭平台配置仍完整可用 | [check.mjs](../../scripts/check.mjs)、[pnpm-workspace.yaml](../../pnpm-workspace.yaml)、[targets.js](../../packages/platform/src/targets.js)、[site-config.js](../../packages/platform/src/site-config.js) | Confirmed | 由 `pnpm run check` 与工作区回归守卫；需保持 `astro>sharp: '-'` | [配置与目标模块](../modules/site-config-and-targets.md)、[代码地图](../code-map.md) |
| 五步 `normalizeText` 幂等且排除未分配码位 `Cn`，与 `MATCH`/`LIKE` 查询共用 | [normalize.js](../../packages/core/src/normalize.js)：`normalizeText / STRIP_RE`；[query.js](../../packages/search/src/query.js)：`prepareQuery / queryLines` | Confirmed | CJK 部首补充区 `U+2E80–2EF3` 多数属 `So` 会被移除，已在注释标明 | [数据模型与归一化模块](../modules/data-model-and-normalization.md)、[检索与分块模块](../modules/search-db-and-chunkfetch.md) |
| 检索页零台词/短词不请求网络，整库流式截断上限默认 30 MiB 且验 SHA-256 | [mount.js](../../packages/search/src/mount.js)：`mountSearch`；[load.js](../../packages/search/src/load.js)：`loadGalleryDb / download` | Confirmed | 真实 CDN 跨域头与未压缩透传仍需在部署后联调验证 | [检索与分块模块](../modules/search-db-and-chunkfetch.md) |
| `chunkfetch` Range 探测与块级校验已实现单测，尚未接入 SQLite VFS | [chunked-file.js](../../packages/core/src/chunkfetch/chunked-file.js)：`ChunkedFile / DEFAULT_RETRY` | Confirmed | 在线检索当前使用整库降级路径 | [检索与分块模块](../modules/search-db-and-chunkfetch.md)、[术语表](../glossary.md) |
| OCR 导入默认只出待校对草稿，必须 `--accept-reviewed` 才进 `data/text/` | [ingest-ocr.mjs](../../scripts/ingest-ocr.mjs)；[labelplus.js](../../packages/core/src/labelplus.js)：`FILE_RE / LABEL_RE` | Confirmed | LabelPlus 依赖文件内文件名与页码策略匹配 | [数据模型与归一化模块](../modules/data-model-and-normalization.md) |
| 每话单 HTML 渐进增强，Comimi 在条漫/文字层/`#p<n>b<i>` 自动退避，备份限制 5 MiB / 20k | [index.astro](../../packages/site/src/pages/[series]/[issue]/[chapter]/index.astro)、[enhanced-reader.js](../../packages/site/src/lib/enhanced-reader.js)、[reading-backup.js](../../packages/site/src/lib/reading-backup.js) | Confirmed | 1,000 页二分滚动数据来自源码既定设计测试记录 | [阅读器与书架模块](../modules/static-reader-and-bookmarks.md) |
| 外观统一使用 Enterprise 品牌蓝变体与局部 contrast 保障，与三态配色共用事件 | [site-appearance.js](../../packages/site/src/lib/site-appearance.js)：`THEMES / appearanceVariables`；[Base.astro](../../packages/site/src/layouts/Base.astro) | Confirmed | 不代表外部浏览器截图已重拍 | [阅读器与书架模块](../modules/static-reader-and-bookmarks.md) |
| ESA/Workers 预留随机证明与预算校验，条件 `If-Match` 启用 R2 指针，IndexNow 只推新增页 | [deploy-budget.mjs](../../scripts/lib/deploy-budget.mjs)、[deploy-proof.mjs](../../scripts/lib/deploy-proof.mjs)、[deploy-ready.mjs](../../scripts/lib/deploy-ready.mjs)、[release.mjs](../../scripts/lib/release.mjs)、[seo-push.mjs](../../scripts/lib/seo-push.mjs) | Confirmed | 源码与本地 HTTP 模拟验证通过；真实云平台上线以实跑部署为准 | [发布流水线模块](../modules/release-pipeline-and-proofs.md)、[主流程](../walkthroughs/one-real-run.md) |
| 文档站独立安装/构建/双语搜索隔离，且 `docs-dev.test.mjs` 仅依赖 `config.mts` 与刷新插件 | [config.mts](../../docs-site/.vitepress/config.mts)、[docs-site.test.mjs](../../scripts/test/docs-site.test.mjs)、[docs-dev.test.mjs](../../scripts/test/docs-dev.test.mjs)、[docs-workflow.test.mjs](../../scripts/test/docs-workflow.test.mjs) | Confirmed | CI 联网 moderate 审计与本地实测结果记于 `change-log.md` | [指南首页](../README.md)、[代码地图](../code-map.md) |
| GitHub 工作流唯一入口、临时 SSH 签名写回与只读本地护栏守卫 | [pipeline-policy.mjs](../../scripts/lib/pipeline-policy.mjs)、[git-signing.mjs](../../scripts/ci/git-signing.mjs)、[release-writeback.mjs](../../scripts/ci/release-writeback.mjs)、[github-pages-publish.mjs](../../scripts/lib/github-pages-publish.mjs)、[_generated.py](../../tools/githooks/_generated.py)、[pre_push.py](../../tools/githooks/pre_push.py) | Confirmed | 真实云端部署、远端 `gh-pages` 推送与 `RELEASE_SIGNING_KEY` 线上写回仍待人类授权发布验收 | [发布流水线模块](../modules/release-pipeline-and-proofs.md)、[代码地图](../code-map.md) |

## 反证与后续问题

- **反证检查（Falsifying check）**：如果未经匹配的 `data/` 或 `site.config.yaml` 改动可以跳过 `build:manifest` / `build:db` 直接通过 `build:site`、如果关闭 `features.platform_config` 后基础阅读/检索失效、或者 `chunkfetch` 在所有源返回全文件时不向上报出 `needs-whole`，则当前静态防漂移与降级模型需要立即修订。
- **下一位读者可能问（Next reader question）**：当台词库持续增长接近或超过 30 MiB 整库限制时，如何在 `packages/core/src/chunkfetch/` 与 `@sqlite.org/sqlite-wasm` 之间实现同步/OPFS VFS 适配器以开启真按块加载？
- **未验证边界**：本指南不代表真实 Cloudflare R2、EdgeOne、ESA、Workers 或 GitHub Pages 线上账户连通性已验收，也不宣称未运行浏览器实拍下的所有 CSS 视觉像素已人工巡检。

证据状态：除特别标注外，本页基于当前源码已确认。
