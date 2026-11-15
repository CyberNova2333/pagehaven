# 版本变更、迁移与决策记录

本页整理影响配置格式、部署契约与维护流程的重大架构演进与迁移指引（原始历史记录参见仓库 `docs/ARCHITECTURE.md` §11 与 `repo-docs/change-log.md`）。

## 重大变更与迁移路径

### 1. 构建栈迁移：`npm` → `pnpm` 工作区与 Astro 7.4 独立解析

- **变化内容**：根工作区迁至 `pnpm@12.6.0`（要求 `pnpm >=10.0.0`、`Node.js >=22.19.0`），通过 `pnpm-workspace.yaml` 注册 `packages/*` 并使用 `workspace:*` 显式链接内部包；`@gallery/site` 当前固定升级到 **Astro 7.4.12**，并以工作区 `overrides: { astro>sharp: '-' }` 彻底剥离 LGPL 原生图像处理依赖。
- **迁移操作**：
  - 根预览或脚本过滤命令请统一使用 `pnpm --filter @gallery/site run preview`（不再使用旧的 npm `--workspace` 写法）；
  - 部署工具由 `scripts/lib/pnpm-runner.mjs` 显式经 `pnpm --package=<pkg>@<ver> dlx` 调用，避免将原生 pnpm 可执行文件误交给 Node 运行；
  - 文档站 `docs-site/` 保持独立锁文件，更新后必须单独执行 `pnpm --dir docs-site install --frozen-lockfile`。

### 2. 四平台静态基线扩展与三阶段不可变发布

- **变化内容**：从早期三平台（Pages / EdgeOne / GitHub）升级为四端主发布矩阵 `edgeone`、`esa`、`github`、`workers`（旧 Cloudflare Pages 降级保留为单独 `cloudflare` 目标，不进入 `--target all` 默认展开）；上线流程拆分为 `publish:r2` → `release:prepare` → `deploy:<target>` → `release:activate`。
- **关键决策原因**：
  - **ESA 硬上限与随机证明预留**：ESA 单站点硬限 2,000 文件 / 1,024,000,000 B；为确保命令成功确实推到了目标实例而非旧域名缓存，Workers 与 ESA 在临时上传副本写入 1 个随机证明文件（≤ 4,096 B），因此业务产物红线分别收缩为 **1,999 文件（ESA）** 与 **17,999 文件（Workers）**；
  - **防半截上线与条件指针切换**：页面在编译时锁定自身的 `gallery.searchDb`，只有在全部目标随机证明核对一致后，才使用对象 `ETag` (`If-Match`) 原子推进 R2 上的 `manifest.json`。

### 3. 台词检索降级方案、覆盖率前置检查与人工校对门禁

- **变化内容**：`packages/search` 现以带有流式长度截断（默认 `db.whole_download_max_bytes: 31457280`）与 SHA-256 校验的整库下载服务于线上检索；`mountSearch` 在下载前先核对嵌入的 `coverage`（`withText === 0 || boxes === 0` 时零网络请求）；`ingest:ocr` 收紧为只产草稿与对照 HTML，必须使用 `--accept-reviewed` 导入已校对稿。
- **迁移提醒**：已有站点的 `site.config.yaml` 如需放宽整库体积上限，可显式调高 `db.whole_download_max_bytes`，同时维持 `db.page_size` 与 `search.request_chunk_size` 一致，以便后续无痛接入 `@gallery/core/chunkfetch` 按块 VFS。

### 4. 默认模板化与功能开关收缩

- **变化内容**：仓库移除示例实际作品，默认以空白通用模板发布（占位域名 `gallery.example.org`、`images.example.org`）；新增默认关闭的 `features.comimi_reader: false` 可选分页，同时保留标准阅读器、文字层及 `#p<n>b<i>` 深链作为无 JS、条漫与检索跳转的最终兜底路径。
- **外观修订**：内置 `paper`、`ocean`、`plum` 主题统一调整为 Enterprise 品牌蓝（`#0c5cab` / `#0a4a8a`）与中性表面变体，`--shadow` 维持 `none` 零阴影风格，并接入本地打包的 `IBM Plex Sans` 字体与 Anime.js 轻量目录入场动效（遵循 `prefers-reduced-motion`）。

## 架构决策记录 (ADR) 摘要

| 决策项 | 选定方案 | 放弃方案与理由 |
| --- | --- | --- |
| **每话页面组织** | 每话产出一份静态 HTML，内含全部图片与文字层 | 放弃每页一个 HTML：2 万话级图集直接击穿 Workers (18k) 与 ESA (2k) 文件预算 |
| **检索归一化与简繁转换** | `NFKC → 去符号 → NFKC → opencc-js/t2cn → 小写` | 放弃先 OpenCC 后 NFKC 或全量双向词典：前者会漏转部首码位，后者体积高达 1.2 MB；未分配码位 `Cn` 透传以跨端一致 |
| **阅读器目录规模** | 静态 HTML 仅嵌常量邻近目录，完整目录懒加载 `/index/<series>.json` 并按 100 话分页 + 二分定位页顶 | 放弃全量内联上万话目录或滚动全表扫描：前者使每话 HTML 体积爆炸，后者在千页长条中造成线性 DOM 布局抖动 |
| **文档站独立隔离** | `docs-site/` 独立 `package.json` + 锁定 VitePress 2 alpha + 手动发布工作流 | 放弃并入根工作区或 push 自动发布：防止文档栈依赖污染业务安全审计与意外覆盖官网静态页面 |
