# 阅读器与书架模块

本模块基于 Astro 7.4.12 静态编译输出阅读站点（`@gallery/site`），覆盖外观令牌生成、无脚本渐进增强阅读器、按需目录分页、可选增强分页以及个人阅读数据备份迁移。

## 静态架构与外观系统

[Astro 配置](../../packages/site/astro.config.mjs) 锁定 `output: 'static'`、`trailingSlash: 'always'`、`inlineStylesheets: 'always'`，并启用官方 `astro/assets/services/noop` 图像服务以彻底去除 `sharp`/`libvips` 依赖。

- **语义配色与三态切换**：[外观变量生成器](../../packages/site/src/lib/site-appearance.js) 根据 `appearance.theme`（`paper`/`ocean`/`plum`，共享 Enterprise 品牌蓝 `#0c5cab`/`#0a4a8a`）与可选十六进制 `accent` 派生 `--bg-*`、`--surface`、`--accent-strong`（按 WCAG 相对亮度自动计算保证对比度 ≥ 4.5）、`--on-accent`、`--reader-bg: #09090b`、`--shadow: none` 与 `--font-heading`；[共享布局](../../packages/site/src/layouts/Base.astro) 内联注入 `<style id="site-color-palettes">`，并与 [配色状态](../../packages/site/src/lib/color-scheme.js) 及 [场景接线](../../packages/site/src/lib/day-night-control.js) 同步浅色/深色/跟随系统三态偏好。
- **随站打包字体与入场动效**：使用 `packages/site/public/fonts/` 中的本地 `IBM Plex Sans` WOFF2（零外部字体请求）；[动效模块](../../packages/site/src/lib/page-motion.js) 通过本地打包的 `animejs` 提供短入场，在 `prefers-reduced-motion` 下跳过。

## 每话单 HTML 阅读器与规模化优化

[章节阅读页](../../packages/site/src/pages/[series]/[issue]/[chapter]/index.astro) 严格遵守每话一个静态 HTML 的预算原则：
- **渐进增强与深链定位**：静态 DOM 完整包含全部页 `<img>` 与按 0–1 坐标叠加的 `.box` 台词框；无 JS 时纵向浏览与文本选中完全可用，页尾内联脚本同步接入阅读模式（单页 / 长条 / 双页、RTL/LTR、键盘翻页 `←`/`→`/空格、`f`/`t`/`Esc`），解析 `#p<n>` 与检索跳入的 `#p<n>b<i>` 高亮目标气泡框；
- **按需目录 100 话分页**：[章节目录模块](../../packages/site/src/lib/chapter-toc.js) 使页面静态 HTML 仅携带常量数量邻近章节，首次打开完整目录时才按需请求 `/index/<series>.json` 并以每组 **100 话** 渲染，支持按关键词过滤、组号直达跳转与跨标签页进度缓存；
- **长条模式二分定位**：长条滚动时按页顶实时纵向位置二分查找当前可见页，将 1,000 页长条单帧 DOM 读取成本从 900 次降至最多 10 次，同时避免因图片懒加载改变高度而产生的缓存坐标失效；
- **多图源自动重试**：[图片加载模块](../../packages/site/src/lib/reader-images.js) 按 `images.hosts` 自动在失败时切换备用域名并支持单页手动重试，提示置于漫画框外不遮挡画面；
- **可选增强分页 (`@yui540/comimi`)**：[增强阅读器模块](../../packages/site/src/lib/enhanced-reader.js) 在 `features.comimi_reader: true` 时提供可选分页界面；当用户切换为长条阅读、勾选“显示文字”或访问 `#p<n>b<i>` 台词锚点时，自动暂停增强层并交还标准阅读器，书签状态继续共用 `gallery:favorites:<chapterKey>`。

## 书架、页码备注与 JSON 备份迁移

- **本地书架与阅读统计**：[书架页](../../packages/site/src/pages/library/index.astro) 与 [bookmarks.js](../../packages/site/src/lib/bookmarks.js) / [library.js](../../packages/site/src/lib/library.js) 管理想读/在读/已读状态、最近阅读（只展示当前目录仍存在的有效章节）、页码书签与单条最多 **200 字符** 的文字备注；页面固定输出 `noindex`。
- **备份导入导出契约**：[阅读备份模块](../../packages/site/src/lib/reading-backup.js) 导出并严格校验 `format: 'pagehaven-reading-backup'`（`version: 1`）JSON 文件，限制体积 ≤ **5 MiB**、总记录 ≤ **20,000** 条，逐一校验普通对象原型、精确字段列表、合法 ID 与分页/备注上限，绝不读写未登记键或可执行内容。

| 场景输入 | 阅读器 / 书架行为 |
| --- | --- |
| 禁用浏览器 JavaScript 打开任意章节 | 全部页图片与 `.box` 台词文本按纵向静态流完整可读 |
| 增强分页开启时点击检索结果 `/.../#p12b3` | `enhanced-reader.js` 主动退避提示并暂停，由标准阅读器精准滚动并高亮第 12 页第 3 框 |
| 导入 > 5 MiB、> 20,000 条或含多余字段的备份 JSON | `parseReadingBackup` 立即抛错拒绝，不污染浏览器 `localStorage` |

## 验证钩子

- 站点行为与交互回归：`packages/site/test/` 全套测试（[reader.test.js](../../packages/site/test/reader.test.js)、[chapter-toc.test.js](../../packages/site/test/chapter-toc.test.js)、[enhanced-reader.test.js](../../packages/site/test/enhanced-reader.test.js)、[reading-backup.test.js](../../packages/site/test/reading-backup.test.js)、[site-appearance.test.js](../../packages/site/test/site-appearance.test.js) 等）
- 构建产出整合测试：[site-build.test.mjs](../../scripts/test/site-build.test.mjs)

## 延伸阅读

- 搜索跳转来源与库绑定：[检索与分块模块](search-db-and-chunkfetch.md)
- 静态产出部署检查：[发布流水线与部署证明模块](release-pipeline-and-proofs.md)

证据状态：除特别标注外，本页基于当前源码已确认。
