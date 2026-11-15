# 术语表

| 术语 | 项目里的意思 | 延伸阅读 |
| --- | --- | --- |
| 唯一配置源 (`site.config.yaml`) | 统一声明站点域名、外观令牌、图片 CDN 主机、SQLite 分块、功能开关、预算与五端部署参数的配置入口，由 `@gallery/platform` 校验并同步生成模板 | [配置与目标模块](modules/site-config-and-targets.md) |
| 不可变发布清单 (`manifest.json`) | 记录版本号、内容指纹 `sourceSha256`、`imageKeys` 与检索库指针 `db` 的 JSON 清单；构建期将不可变 `manifest-<version>.json` 与共享指针分离存储 | [一次真实主流程](walkthroughs/one-real-run.md) |
| 内容指纹 (`sourceSha256` / `galleryFingerprint`) | 对作品目录与台词框内容计算的 SHA-256 摘要，用于阻止 `build:site` 把过期或不一致的 SQLite 检索库嵌入静态页面 | [发布流水线模块](modules/release-pipeline-and-proofs.md) |
| 安全对象路径 (`isSafeObjectPrefix` / `isSafeObjectKey`) | 允许进入 CDN 与 R2 URL 的纯 ASCII 相对路径契约，拒绝空格、`..`、空段、控制字符与需 URL 转义字符 | [数据模型与归一化模块](modules/data-model-and-normalization.md) |
| 台词归一化 (`normalizeText`) | 构建索引与浏览器查询共用的五步纯函数流水线（NFKC → 去标点/符号/控制字符/变体选择符 → NFKC → `opencc-js/t2cn` → 小写） | [数据模型与归一化模块](modules/data-model-and-normalization.md) |
| 混合检索策略 (`MATCH` / `LIKE`) | 归一化查询 ≥ 3 字走 SQLite `FTS5 trigram` 短语 `MATCH`，恰好 2 字退化为转义 `LIKE`，< 2 字直接本地拒绝且不下载数据库 | [检索与分块模块](modules/search-db-and-chunkfetch.md) |
| 固定构建检索库 (`gallery.searchDb`) | `build:site` 内联进搜索页配置的固定版本 `{ version, key, size, sha256, pageSize, chunkSize, chunks }`，防止旧静态页访问新版本库格式 | [检索与分块模块](modules/search-db-and-chunkfetch.md) |
| 整库下载上限 (`whole_download_max_bytes`) | 浏览器加载 `.sqlite` 时的字节上限守卫（默认 30 MiB），流式读取超限即中断并在校验整份 SHA-256 后才交给 `sqlite-wasm` | [检索与分块模块](modules/search-db-and-chunkfetch.md) |
| 分块取块基建 (`chunkfetch`) | `@gallery/core` 中已实现并单测的多源 HTTP Range 探测、EMA 延迟优选与逐块 SHA-256 校验层，当前尚未接入在线 SQLite VFS | [检索与分块模块](modules/search-db-and-chunkfetch.md) |
| 每话单 HTML 渐进阅读 | Astro 7.4 把同一话所有页与 `.box` 坐标框编入单一 HTML；无脚本时纵向可读，启用脚本后切换单页/条漫/双页与 `#p<n>b<i>` 定位 | [阅读器与书架模块](modules/static-reader-and-bookmarks.md) |
| 按组目录分页 (`series.json`) | 章节页面静态内联常量规模邻近目录，打开完整侧栏时懒加载作品分片 JSON 并按每组 100 话分页展示 | [阅读器与书架模块](modules/static-reader-and-bookmarks.md) |
| 阅读备份 (`pagehaven-reading-backup`) | 浏览器端 `library`、`progress`、`bookmarks` 与 200 字 `notes` 的 JSON 迁移格式，受 5 MiB 与 20,000 条记录上限及严格字段白名单保护 | [阅读器与书架模块](modules/static-reader-and-bookmarks.md) |
| 公开配置与部署控制模板分离 | `GENERATED_FILES`（`_headers`、`_redirects`、`edgeone.json`）随开关进 `dist`；`DEPLOY_CONFIG_FILES`（`wrangler.jsonc`、`esa.jsonc`）绝不复制进 `dist` | [配置与目标模块](modules/site-config-and-targets.md) |
| ESA 总量上限 (`1,024,000,000` B / 2,000 文件) | 阿里云 ESA 静态托管硬配额；扣除 1 个部署验证文件及 4,096 B 预留后，业务静态产物最多容纳 1,999 文件 | [发布流水线模块](modules/release-pipeline-and-proofs.md) |
| 随机部署证明 (`deploy-proof`) | 部署前注入临时上传副本的随机文件，绑定目标、版本、指纹与环境；CLI 退出 0 后须从目标 HTTPS 根地址实测读回匹配才记录成功回执 | [发布流水线模块](modules/release-pipeline-and-proofs.md) |
| 条件启用 (`release:activate`) | 所有选定目标回执一致后，使用存储 `ETag`（`If-Match` / `If-None-Match`）原子更新 R2 共享指针 `manifest.json` 的步骤 | [发布流水线模块](modules/release-pipeline-and-proofs.md) |
| `OUT_DIR` | 构建、建库、OCR 草稿与发布回执产物目录的覆盖环境变量（默认指向仓库根 `out`） | [一次真实主流程](walkthroughs/one-real-run.md) |
| `CHAPTERS` | 逗号分隔的 `<series>/<issue>/<chapter>` 列表环境变量，用于限定 `ingest:labelplus` 与 `ingest:ocr` 的处理章节范围 | [数据模型与归一化模块](modules/data-model-and-normalization.md) |
| `--dry-run` | 预览变更与诊断但不写入文件的命令行参数，同时用于 `init` 与 `ingest:labelplus` | [配置与目标模块](modules/site-config-and-targets.md) |
| `--accept-reviewed` | `ingest:ocr` 的显式导入参数；默认运行仅输出待校对草稿，只有人工校对并传入该参数才正式写入台词 JSON | [数据模型与归一化模块](modules/data-model-and-normalization.md) |
| `activateRelease` | `scripts/lib/release.mjs` 的生产指针条件切换函数，在核对全目标回执后以 `If-Match` 更新共享 `manifest.json` | [发布流水线模块](modules/release-pipeline-and-proofs.md) |
| `loadGalleryDb` | `@gallery/search` 中按固定 `release` 元数据流式下载 `.sqlite`、截断超限响应并校验 SHA-256 的浏览器加载入口 | [检索与分块模块](modules/search-db-and-chunkfetch.md) |
| `images.hosts` | `site.config.yaml` 中配置的 1–2 个公开 CDN 读取域名，阅读器与检索端经此读取 R2 私有源的 WebP 与 SQLite | [配置与目标模块](modules/site-config-and-targets.md) |
| `example.org` | 通用模板默认占位域名（如 `gallery.example.org`、`images.example.org`）；生产发布会被 `releasePlan` 拒绝 | [配置与目标模块](modules/site-config-and-targets.md) |
| `pnpm run check` | 仓库根静态检查入口，依次验证配置同步、Web 标准边界、禁用 `sharp`、README 锚点、CI 策略与目标预算 | [一次真实主流程](walkthroughs/one-real-run.md) |
| `prepareQuery` | `@gallery/search` 的查询前预处理函数，归一化后按字符数返回 `too-short` / `like` / `match` 模式以决定是否跳过下载数据库 | [检索与分块模块](modules/search-db-and-chunkfetch.md) |

证据状态：除特别标注外，本页基于当前源码已确认。
