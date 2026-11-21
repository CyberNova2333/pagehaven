# 跨模块交互与扩展 FAQ

本页说明各工作区包与构建脚本在一次生命周期中的交接协议，并列出做前端主题、阅读器或部署扩展时最常见的契约疑问。

## 端到端数据与版本锁定链条

Pagehaven 最核心的工程保障是**“防漂移交接”**——确保线上静态页面永远只访问与自身内容完全匹配的 SQLite 检索库与资源版本：

1. **`@gallery/platform` → `site.config.yaml` / `generated/`**：`build:config` 校验配置文件，渲染公共平台规则和部署控制模板，并在 `pnpm run check` 中检查已提交的 `packages/platform/generated/` 与当前配置是否漂移。
2. **`build:manifest` → `out/manifest.json`**：读取 `data/meta/` 与 `data/text/`，用 `galleryFingerprint(gallery)` 计算涵盖全站目录、页表和全部台词的 `sourceSha256`；此时特意将 `manifest.db` 置为 `null`。
3. **`build:db` → `@gallery/core/db`**：读回 `manifest.json` 并再次计算当前内容的 `galleryFingerprint`，确认与清单一致后，用 `@sqlite.org/sqlite-wasm` 生成表结构与 `FTS5 trigram` 索引，导出 `gallery-<version>.sqlite` 及其 64 KiB 分块摘要 `.chunks.json`，最终仅回填 `manifest.db`。
4. **`build:site` → `@gallery/site`**：再度校验已有 `manifest.json` 的 `version`、`site.domain`、`sourceSha256` 以及固定 `db` 指针，全部匹配后才将 `site-config.json`、`gallery.json` 和每话 `text/*.json` 写入 `packages/site/src/generated/` 并调用 Astro 编译。
5. **`publish:r2` → `deploy:*` → `release:activate`**：R2 先落盘不可变的对象路径（`img/...`、`db/gallery-<version>.sqlite`、`manifest-<version>.json`），再把绑死了 `gallery.searchDb` 的 `dist/` 推向所选平台；只有当全部目标回执（包含随机验证文件核对）都匹配同一个 `(version, fingerprint)`，才会用 `If-Match: ETag` 条件写更新生产 `manifest.json`。

## 模块间关键状态切换交互

### 检索页的延迟加载与版本绑定

作品名、作者和标签筛选使用独立的作品目录。台词表单按以下条件加载检索资源。

- 若全站无话（`chapters === 0`）或尚无任何台词框（`withText === 0 || boxes === 0`），直接展示明确空态提示，**永远不发起任何数据库网络请求**；
- 查询串折叠并转小写后不足两个 Unicode 码位时，就地提示“请至少输入 2 个字”。
- 首次有效台词查询才加载 SQLite 运行时、OpenCC 词典和页面绑定的 `config.db.release`。整库路径验证完整文件的 SHA-256，分块路径验证清单及 SQLite 实际读取的块。

### 标准阅读器与增强分页（Comimi）的协作边界

`EnhancedReader`（受 `site.config.yaml` 中 `features.comimi_reader` 控制，默认 `false`）并非独立替换整页，而是与标准阅读器 `reader.galleryReader` 协同工作：
- 标准阅读器继续统一管理 URL `#p<n>` / `#p<n>b<i>`、阅读进度持久化（首页与书架据此继续阅读）、无 JS 回退以及长条/文字层模式；
- 一旦读者在增强分页激活期间切换到长条模式（`mode === 'long'`）、开启“显示文字”复选框或访问 `#p<n>b<i>` 台词定位锚点，`enhanced-reader.js` 会主动暂停增强组件并显示过渡说明，让标准阅读器接管精确坐标渲染与高亮。
- 书签星标通过 `bookmarks.js` 双向同步到同一话的 `gallery:favorites:<chapterKey>`。

### 昼夜场景开关与三态偏好的同步

`Base.astro` 首屏内联脚本 `initializeColorScheme` 从存储恢复三态（`system` / `light` / `dark`），并向外派发 `pagehaven:color-scheme-change` 事件；`day-night-control.js` 把交互式昼夜开关连接到同一状态源。点击快捷开关固定明暗后，读者仍可从三态选择器切回“跟随系统”；若场景资源加载失败，原生三态表单依然完全可用。

## 扩展与二次定制 FAQ

**可以直接给 `@gallery/core` 或 `@gallery/search` 增加 Node 文件系统工具吗？**
不可以。这两个包和 `@gallery/site` 直接在浏览器上下文与独立沙箱单测中运行，`scripts/check.mjs` 会拒绝任何 `node:*` 导入。文件操作、命令行解析与部署逻辑应放在 `scripts/` 或 `scripts/lib/` 中，需要跨环境复用的纯逻辑则写成 Web 标准函数放入 `packages/core/src/`。

**如何在不修改核心阅读器代码的条件下微调全站外观？**
优先通过 `site.config.yaml` 的 `appearance`（`theme`: `paper`/`ocean`/`plum`，任意 6 位 `#rrggbb` `accent`，`font`: `sans`/`serif`）以及 `pnpm run customize` 工具调整。`site-appearance.js` 会自动保证链接对比度（≥ 4.5）与按钮前景色对比。

**如何启用按块检索？**
在 `site.config.yaml` 中开启 `features.range_search` 并完整重建后，搜索页会在专用 Worker 中按 HTTP Range 读取并校验所需分块。CDN 需要返回 206，并允许浏览器跨域读取 `Content-Range`。

**想给站内增加新的自定义静态跳转页怎么写最安全？**
全部配置在 `site.config.yaml` 的 `redirects` 映射中，`build:site` 会通过 `scripts/lib/static-output.mjs` 的 `redirectOutputPaths` 与 `metaRefresh` 预检源路径合法性并转义目标 URL，同时产出平台重定向规则（支持规则的平台）与实体兜底 HTML。
