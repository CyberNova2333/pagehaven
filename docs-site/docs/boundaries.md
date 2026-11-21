# 能力边界与安全假设

Pagehaven 的所有设计与代码审查都绕不开 `AGENTS.md` 与 `docs/ARCHITECTURE.md` 确立的**七条铁律**与**安全边界**。在扩展模块或定制站点之前，请先确认以下硬性约束。

## 七条工程铁律

1. **核心与浏览器包严禁依赖 Node 内置模块**
   `packages/core/`、`packages/site/`（含客户端脚本与公共工具）与 `packages/search/` 必须只使用 **Web 标准 API**（如 `crypto.subtle`、`Uint8Array`、`TextEncoder`、`fetch`、`URL` 与 Wasm），不得导入 `node:fs`、`node:crypto`、`node:path` 等接口。`scripts/check.mjs` 会静态扫描并阻断违规导入。Node 文件系统与进程操作只能留在 `scripts/` 与 `packages/platform/` 构建工具中。
2. **纯静态基线**
   即使不生成平台文件（`features.platform_config: false`），全部内容浏览、多模阅读、文字层定位、书架与前端检索必须 100% 正常工作。`_headers`、`_redirects`、`edgeone.json`、`wrangler.jsonc`、`esa.jsonc` 只做静态路由、缓存与安全头增强，**禁止引入 Edge Functions 或 Workers 服务端路由作为访问前提**。
3. **存储与读取严格分离（R2 私有）**
   Cloudflare R2 桶永远保持私有；写入凭据（`R2_*`）仅出现在 CI 发布的 `scripts/publish-r2.mjs` 与 `scripts/release.mjs` 中。浏览器端与静态 HTML 对图片和 SQLite 文件的读取一律通过 `images.hosts`（1–2 个公开 CDN 域名，经 S3v4 私有回源读 R2）。
4. **SQLite 页大小与取块大小对齐**
   `site.config.yaml` 中 `db.page_size` 必须严格等于 `search.request_chunk_size`（默认均为 `4096` 或 `65536`；当前配置 `db.page_size: 4096`，`db.chunk_size: 65536`，而 `search.request_chunk_size` 与数据库页对齐策略由 `packages/platform/src/site-config.js` schema 强制校验），且禁止生成 `-wal`/`-shm` WAL 模式文件（文件头固定非 WAL 并经 `VACUUM` 紧排）。
5. **每话仅生成一份静态 HTML**
   为适应免费托管平台的文件数上限（Workers guard `18,000`；ESA 硬上限 `2,000` 含 1 个证明预留 = `1,999` 业务文件），同一话的全部漫画页都内联在同一静态 HTML 内，通过页内 `#p<n>` 与异步请求 `/index/<series>.json` 完成翻页和目录导航。
6. **零凭据泄漏与零硬编码**
   任何真实账号 ID、桶名、API Token、个人工作站路径或私密设计稿禁止进入源代码、配置文件、测试用例、Git 提交信息或文档。默认模板中的域名仅使用 RFC 保留占位（`gallery.example.org`、`images.example.org`），`scripts/lib/placeholder.mjs` 与 `tools/githooks/pre-commit` 会对敏感模式做提交前拦截。
7. **配置错误立即失败（Fail Loud）**
   缺少环境变量、YAML 语法错误、内容清单与数据库 `sourceSha256` 不一致、非法对象路径或超过预算上限时，脚本必须明确打印原因并以非零状态退出，绝不静默跳过或写入受损产物。

## 安全模型与信任边界

### 对象存储与浏览器下载校验

- **安全对象路径契约（`packages/core/src/object-path.js`）**：`db.prefix`（`isSafeObjectPrefix`）与媒体对象 key（`isSafeObjectKey`）仅允许无需 URL 转义的安全 ASCII 相对路径（以 `/` 结尾、禁止空白、`..`、`.`、空段或控制字符），防止构建与前端拼接出路径穿越 URL。
- **整库下载上限与流式截断（`packages/search/src/whole.js`）**：下载 SQLite 检索库时：
  1. 先校验前端内嵌 `gallery.searchDb` 元数据（或 manifest）中的 `key`、`size`（正整数）、`sha256`（64 位 hex）以及 `size <= whole_download_max_bytes`（默认 `31,457,280` B）；
  2. 流式读取 `ReadableStream` 时累计字节数并实时比对上限与 `meta.size`，超长立即 `controller.abort()`；
  3. 完整接收后通过 `crypto.subtle.digest('SHA-256', ...)` 核对整份 SHA-256，不符即丢弃，绝不将篡改或截断的字节交给 SQLite Wasm。

### 本地书架与 JSON 备份边界

`packages/site/src/lib/reading-backup.js` 严格审计导入文件：
- **体积与条数硬限制**：最大 **5 MiB**（`5 * 1024 * 1024` B）与最多 **20,000** 条总记录；
- **严格字段白名单**：仅认 `format: 'pagehaven-reading-backup'` 与 `version: 1`，逐条核验 `library`、`progress`、`bookmarks`、`notes`（单条备注最多 **200** 字符，原型仅允许普通字面量对象且检查所有键数量一致），不读取也不写入任何未登记 `localStorage` 键、URL 或可执行内容。

### 隐私与 SEO 隔离

- 个人书架 `/library/` 与所有 `preview` 构建自动注入 `<meta name="robots" content="noindex" />` 且不输出 `<link rel="canonical">`。
- 站点不加载第三方字体服务、分析脚本或广告 SDK；本地随站打包 `IBM Plex Sans` 字体并在 `packages/site/public/licenses/` 随附第三方许可文件。

### 非目标与已知限制

- 在 `site.config.yaml` 中开启 `features.range_search` 并完整重建后，搜索页会在专用 Worker 中按 HTTP Range 读取并校验所需分块。默认关闭，整库下载上限为 30 MiB。
- 仓库不提供账号同步；跨设备迁移依赖用户在 `/library/` 手动导出与导入 JSON 备份。
