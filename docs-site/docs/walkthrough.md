# 一次真实构建与发布演练

本页与仓库内部指南（`repo-docs/walkthroughs/one-real-run.md`）保持同步，带你沿着一次真实运行，看清楚数据、清单、SQLite 库、静态 HTML 和四端部署证明是如何环环相扣的。

## 代表性分支与拒绝边界

| 输入或触发条件 | 系统动作与实际结果 |
| --- | --- |
| 默认空内容模板（无章节） | 构建正常完成；生成首页、`/search/`、`/library/` 与 `404.html`，检索页渲染空态提示 |
| 同一内容、`manifest.json` 与 `gallery.sqlite` | `build:site` 校验指纹与版本一致后将固定 `searchDb` 元数据嵌入页面 |
| 单独改动 `data/` 或域名后直接运行 `build:site` | `sourceSha256` 或域名校验失败，构建报错并拒绝写出半新半旧的 `dist/` |
| 无 R2 凭据运行 `build:manifest` | 在线图片核对标为“未校验（unverified）”，不会伪报图片线上可访问 |
| 产物恰有 2,000 个文件，目标包含 `esa` 或 `all` | 加上 1 个部署验证文件预留后达到 2,001，发布前预算检查直接拒绝上传 |
| Workers / ESA 命令退出 0，但验证 URL 返回旧版或别家内容 | 随机部署证明文件不匹配，拒绝写入成功回执，共享生产 `manifest.json` 保持原版本 |

## 阶段一：固定配置与发布清单（`build:config` → `build:manifest`）

1. **`pnpm run build:config`**：由 `@gallery/platform` 解析 `site.config.yaml`，校验 `site`、`images`、`db`、`search`、`features`、`budgets` 与 `deploy` 字段，同步写出 `packages/platform/generated/` 中的公共配置与部署模板。
2. **`pnpm run build:manifest`**：读取 `data/meta/*.yaml` 与 `data/text/*.json` 构建内存 `Gallery` 模型，调用 `isSafeObjectPrefix` 验证 `db.prefix`，按字节序收集全部 WebP 与封面键 `imageKeys`，计算全量内容摘要 `sourceSha256 = galleryFingerprint(gallery)`，写入 `out/manifest.json`（此时 `db` 恒为 `null`）。

## 阶段二：构建绑定版本的台词检索库（`build:db`）

1. 读取已有 `out/manifest.json`，重新计算当前内容 `galleryFingerprint`，确认与清单一致、且版本号（`RELEASE_VERSION` 或 UTC `YYYY-MM-DD`）相同。
2. 在 `@sqlite.org/sqlite-wasm` 中依次执行：`PRAGMA page_size=<db.page_size>` → 建表（`series`、`issues`、`chapters`、`pages`、`lines` 与外部内容虚表 `lines_fts` using `fts5(..., tokenize='trigram')`）→ 事务插入归一化后的 `text_norm` → `INSERT INTO lines_fts(lines_fts) VALUES('rebuild')` → 建 4 条外键索引 → `PRAGMA journal_mode=DELETE` → `VACUUM`。
3. 导出 `out/db/gallery-<version>.sqlite` 并计算 64 KiB 分块摘要文件 `gallery-<version>.sqlite.chunks.json`（含整份 SHA-256 与逐块 SHA-256），最后回填 `manifest.json` 中的 `db` 指针。

## 阶段三：编译每话单页与静态兜底文件（`build:site` → `build:index` → `build:sitemap`）

1. **`redirectOutputPaths` 预检**：在清空旧产物前校验所有 `site.config.yaml` 重定向源路径与输出边界，防止路径穿越。
2. **指纹与版本门禁**：校验 `manifest.sourceSha256`、`manifest.site.domain` 与 `manifest.version`，通过后才把 `site-config.json`、`gallery.json` 和每话 `text/<series>/<issue>/<chapter>.json` 写入 `packages/site/src/generated/`。
3. **Astro 静态编译**：以 `inlineStylesheets: 'always'` 与 noop 图像服务为每一话生成唯一静态 HTML（全部图片与气泡坐标保留在静态 DOM，无 JS 可读）。
4. **平台配置与索引收尾**：按 `features.platform_config` 决定是否写入 `_headers`、`_redirects`、`edgeone.json`；写出 `.nojekyll` 与转义安全的静态跳转 `metaRefresh` HTML；随后生成 `/index/series.json`、按作品拆分的 `/index/<series>.json`、`sitemap.xml` 与可选 `<indexnow_key>.txt`。

## 阶段四：发布检查与三阶段原子上线（`check` → `publish:r2` → `release:*`）

1. **`pnpm run check`（可配 `DEPLOY_TARGET=all`）**：核对 Web 标准边界、锁文件无 `sharp`、配置同步、CI 策略、README 链接、SQLite 头页大小、`dist/` 每话 HTML 覆盖率及多目标容量预算（ESA ≤ `1,999`、Workers ≤ `17,999` 业务文件）。
2. **R2 上传与准备**：`publish:r2` 按清单校验并上传新增 WebP、版本化 `.sqlite`/`.chunks.json` 与不可变 `manifest-<version>.json`；`release:prepare` 保存旧 `manifest.json` 的 `ETag` 与指纹到 `out/release-state.json`。
3. **多端部署与随机证明核对**：`deploy:<target>` 为 Workers / ESA 创建临时上传副本，注入唯一随机证明文件并调用 `pnpm --package=... dlx` 运行固定版本 CLI；命令成功后立即请求目标 HTTPS 根地址核对该随机文件，匹配才写出回执。
4. **条件启用与搜索通知**：所有选定目标均取得一致 `(version, fingerprint)` 回执后，`release:activate` 以 `If-Match` 原子更新 R2 共享指针 `manifest.json`；随后 `push:search` 仅推送新出现页面的 URL 至 IndexNow。

## 继续深入

- 需要逐包排查代码与定位：前往 [源码地图与贡献工作流](/docs/code-map)
- 需要系统级模块原理分析：前往 [核心子系统与架构全景](/docs/architecture)
