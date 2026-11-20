# 多模式运行与多平台部署

Pagehaven 把“业务站点静态输出”与“大体积媒体/检索库”彻底拆开：**同一份 `dist/` 可部署到多个免费边缘托管平台，而 WebP 图片与 SQLite 检索库统一上传至私有 Cloudflare R2 并经 CDN 域名分发。**

## 本地运行模式对比

| 模式 | 命令 | 适用阶段 | 默认输出/端口 |
| --- | --- | --- | --- |
| 全量构建 | `pnpm run build` | 依次执行 `build:config` → `build:manifest` → `build:db` → `build:site` → `build:index` → `build:sitemap` | `dist/` 与 `out/` |
| 夹具冒烟构建 | `DATA_DIR=packages/core/test/fixtures/data DIST_DIR=... OUT_DIR=... pnpm run build` | 本地在不污染正式内容下验证构建链路 | 自定义临时目录（仍会更新 `packages/site/src/generated/`） |
| 静态构建预览 | `pnpm --filter @gallery/site run preview` | 验收最终静态 HTML、文字层、`404.html` 与检索页面 | `http://localhost:4321` |
| 可视化配置工具 | `pnpm run customize` | 安全调整 `site.config.yaml` 中的外观、Logo 与功能开关 | `http://127.0.0.1:4318/#token=...` |
| 独立文档站开发 | `pnpm --dir docs-site install --frozen-lockfile && pnpm --dir docs-site run docs:dev` | 编辑文档站与观察双语搜索刷新 | `scripts/docs-dev.mjs` 固定开发端口（默认 `4173` 等以启动日志为准） |

## 多平台静态托管矩阵

`@gallery/platform`（`packages/platform/src/targets.js`）声明了 5 个支持目标，其中 `DEFAULT_RELEASE_TARGETS`（即 `--target all` 展开集合）包含 `edgeone`、`esa`、`github`、`workers`，传统 Cloudflare Pages 保留为独立的 `cloudflare` 目标：

| 目标 ID | 文件数上限 / 业务守卫 | 总大小上限 / 单文件上限 | 预览支持 | 公开响应配置与控制模板 |
| --- | --- | --- | --- | --- |
| `edgeone` | 不设总文件预算守卫 | 单文件随全站 20 MiB 守卫 | 支持（`-e preview`） | 公共 `edgeone.json`、`_headers`、`404.html` |
| `esa` | 硬上限 `2,000`（预留 `1` 证明文件 → 业务 ≤ `1,999`） | 总大小 `1,024,000,000 B`（预留 `4,096 B` 证明） | 支持（staging DNS + TLS 校验） | `esa.jsonc` 控制模板不进 `dist/`，临时副本注入项目名后部署 |
| `github` | 无额外文件数上限（全站 `18,000` 守卫） | 总大小 `1,000,000,000 B` | **不支持**（`preview` + `github`/`all` 拒绝） | 必含 `.nojekyll`、`404.html`、`index.html`；推向 `gh-pages` 分支 |
| `workers` | `18,000`（预留 `1` 证明文件 → 业务 ≤ `17,999`） | 单文件随全站 20 MiB 守卫 | 支持（独立 `CLOUDFLARE_PREVIEW_WORKER_NAME`） | `wrangler.jsonc` 不进 `dist/`，Static Assets + `404-page`，零函数入口 |
| `cloudflare` | `18,000` | 单文件 `20 MiB`（平台 25 MiB 下留余量） | 支持（`--branch preview`） | 传统 Pages 入口，不进入默认 `all` |

> 关闭 `features.platform_config: false` 时，构建不再生成 `_headers`、`_redirects` 与 `edgeone.json`；站点依赖相对 URL 与标准 HTTP 语义保持纯静态可用。

## 不可变 R2 存储与三阶段发布

`.github/workflows/release.yml` 编排整套发布剧本，确保**站点 HTML 绑定构建时固定的 `gallery.searchDb` 版本**，绝不让旧页面查到新版本结构，也不在部分平台失败时移动线上共享指针：

1. **`pnpm run publish:r2`**：校验安全对象路径后，把版本化检索库（`db/gallery-<version>.sqlite` + `.chunks.json`）、覆盖图与缺失图片上传到 R2 私有桶，并写出不可变版本清单 `manifest-<version>.json`；旧线上指针暂存为 `out/manifest-previous.json`。
2. **`pnpm run release:prepare`**：记录当前线上 `manifest.json` 的 ETag 与构建指纹到 `out/release-state.json`（预览与仅上传模式不启用生产指针）。
3. **`pnpm run deploy:<target>`**：使用固定版本的官方 CLI（`wrangler@4`、`edgeone@1`、`esa-cli@1.0.13`）经 `pnpm --package=... dlx` 执行。其中 `workers` 与 `esa` 会复制临时上传副本并写入**随机部署证明文件**，随后从目标 HTTPS 根地址（ESA staging 使用指定控制台 IP 但保留 Host、SNI 与 TLS 证书校验）请求该随机文件，核对无误才写入成功回执。
4. **`pnpm run release:activate`**：核对本次选定所有目标均已产出一模一样的版本与内容指纹回执后，使用 `If-Match: <etag>`（首次发布用 `If-None-Match: *`）原子切换 `manifest.json`。
5. **`pnpm run push:search` 与 `pnpm run status`**：比对 `manifest.json` 与 `manifest-previous.json` 的新增页面 URL，分批（≤ 10,000/批）推送至 IndexNow（若已配置 `seo.indexnow_key`），并回写 `STATUS.md`。

## 环境变量与密钥矩阵

### 构建与路径覆盖变量（非敏感）

| 变量名 | 默认值 / 可选值 | 用途 |
| --- | --- | --- |
| `CONFIG_FILE` | 仓库根 `site.config.yaml` | 覆盖配置文件路径 |
| `DATA_DIR` | 仓库根 `data` | 覆盖漫画元数据与台词目录 |
| `DIST_DIR` | 仓库根 `dist` | 覆盖静态站点输出目录 |
| `OUT_DIR` | 仓库根 `out` | 覆盖清单、SQLite 与临时回执输出目录 |
| `DEPLOY_TARGET` | 无（单个目标或 `all`） | 让 `pnpm run check` 额外校验对应目标的文件/字节预算 |
| `DEPLOY_ENV` | `production` \| `preview` | 区分生产与预览部署计划 |
| `RELEASE_VERSION` | 默认 UTC 日期 `YYYY-MM-DD` | 固定本次发布版本号（仅允许字母数字与 `._-`） |
| `CHAPTERS` / `LABELPLUS_PAGES` | 逗号分隔章节 key；`auto` \| `number` \| `sequence` | 控制 `ingest:labelplus` 与 `ingest:ocr` 范围与页码映射 |
| `INDEXNOW_ENDPOINT` | `https://api.indexnow.org/indexnow` | 覆盖 IndexNow 推送端点（测试或代理使用） |

### CI 机密凭据（严禁写入仓库或前端代码）

| 用途范围 | 必需环境变量 | 说明与注入方式 |
| --- | --- | --- |
| 对象存储发布（R2） | `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET` | 仅在 `publish:r2`、`release:*`、`status` 阶段通过 CI secrets 注入 |
| Cloudflare Workers / Pages | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_WORKER_NAME`、`WORKERS_DEPLOY_URL`（预览另需 `CLOUDFLARE_PREVIEW_WORKER_NAME`） | 经 `run-with-secrets.mjs` 注入单个子进程 |
| EdgeOne Pages | `EDGEONE_API_TOKEN`、`EDGEONE_PROJECT_ID`、`EDGEONE_PROJECT_NAME` | `deploy.mjs` 先按项目 ID 核对唯一项目名，CLI 令牌经 `EDGEONE_PAGES_API_TOKEN` 环境变量传入（不走命令行明文） |
| 阿里云 ESA Pages | `ESA_ACCESS_KEY_ID`、`ESA_ACCESS_KEY_SECRET`、`ESA_PROJECT_NAME`、`ESA_DEPLOY_URL` | `esa-cli@1.0.13` 搭配 `--no-preview`，预览验证可额外传测验 IP（如 `ESA_STAGING_IP` 等内部参数以 `deploy-ready` 为准） |
| GitHub Pages | `GITHUB_PAGES_REPO`、`GITHUB_PAGES_TOKEN`、`RELEASE_SIGNING_KEY` | 校验 `.nojekyll`、`404.html`、`index.html` 后以 SSH 签名提交推至 `gh-pages` |

> GitHub Actions 发布入口配置在 `.github/workflows/release.yml`，使用仓库 Secret `PUBLISH_SECRETS_YML` / `DEPLOY_SECRETS_YML`（YAML/JSON 标量键值对象）及 `RELEASE_SIGNING_KEY`（用于 `gh-pages` 与 `STATUS.md` / `data/text` 签名写回的专用 Ed25519 私钥）。**绝不可在任何配置文件、日志或文档中打印或保存真实凭据。**

## 生产上线前核对清单

1. `site.config.yaml` 中 `site.domain` 与 `images.hosts` 已替换为真实域名，不再保留 `example.org`、`localhost` 或占位主机（`releasePlan` 会在生产发布时直接拒绝示例域名）。
2. 目标 CDN 域名已正确配置 S3v4 私有回源到 Cloudflare R2，且静态读响应头包含浏览器访问 SQLite 与字体/页面所需的 `Access-Control-Allow-Origin`、`ETag` 与合理 `Cache-Control`。
3. 如启用 `seo.indexnow_key`（8–128 位 `[A-Za-z0-9-]`），确认 `dist/<key>.txt` 已一并生成。
4. 本地已跑通 `pnpm run build` 与 `DEPLOY_TARGET=all pnpm run check`（或具体目标）且退出码为 `0`。
5. 首次接入新平台先执行一次 `DEPLOY_ENV=preview` 真实部署并抽检阅读、`/search/` 台词跳转与 `/library/` 本地读写。
