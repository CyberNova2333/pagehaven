# 设计系统说明：页间 · Pagehaven 漫画库与静态阅读器

## 1. 设计定位与约束

Pagehaven 是面向静态漫画馆与连载归档的多端出版与阅读站点，视觉实现由 [Base.astro](packages/site/src/layouts/Base.astro) 与 [site-appearance.js](packages/site/src/lib/site-appearance.js) 共同定义。

- **纯静态与受限外观契约**：构建期通过 `site.config.yaml` 的 `appearance`（`theme`、`accent`、`font`、`show_search`、`show_library`）生成有限语义 CSS 变量，不接受任意外部 CSS。
- **低开销静态输出**：站点采用 `inlineStylesheets: 'always'`，样式直接内联到每话 HTML（应对 18,000 文件级预算）；字体使用随 `packages/site/public/fonts/` 打包的 `IBM Plex Sans` WOFF2，不依赖外部字体服务。
- **零阴影与高可读对比度**：所有内置变体保持 `--shadow: none` 与 `--shadow-hover: none`；自定义 `--accent` 时，`site-appearance.js` 会基于 WCAG 相对亮度自动计算 `--accent-strong`（对比度目标 ≥ 4.5）与 `--on-accent`。
- **无 JavaScript 可读**：禁用脚本时，全部漫画页面与台词文本仍按静态纵向流完整显示；启用脚本后才进入单页/双页/条漫控制与动效增强。

## 2. 主题预设与语义令牌

内置三个主题 ID（`paper`、`ocean`、`plum`）共享 Enterprise 品牌蓝主色，仅在 `--surface` 表面层次上作轻量区分：

| 预设 ID | 显示名称 | 默认主色 `--accent` | 浅色表面 `--surface` | 深色表面 `--surface` |
| --- | --- | --- | --- | --- |
| `paper` | 品牌蓝 · 轻纸 | `#0c5cab` | `#eeeeef` | `#161618` |
| `ocean` | 品牌蓝 · 雾面 | `#0c5cab` | `#e2eaf2` | `#0a2440` |
| `plum` | 品牌蓝 · 墨面 | `#0a4a8a` | `#e7e7e8` | `#1c1c1e` |

核心语义变量映射（由 `<style id="site-color-palettes">` 注入并在浅/深色下分别生效）：

| 语义令牌 | 浅色默认（`paper`） | 深色默认（`paper`） | 典型用途 |
| --- | --- | --- | --- |
| `--bg-top` / `--bg-mid` | `#fafafa` | `#09090b` | 站内主画布背景与主题色元标签 |
| `--bg-low` / `--surface` | `#eeeeef` | `#161618` | 卡片底面、目录条目与导航区块 |
| `--surface-soft` | `#e7e7e8` | `#222224` | 次级底衬与控件底色 |
| `--ink` | `#09090b` | `#fafafa` | 页面主标题与高强调文本 |
| `--text` / `--text-dim` | `#303032` / `#626263` | `#ddddde` / `#b2b2b3` | 说明正文与辅助元数据 |
| `--accent` / `--accent-strong` | `#0c5cab` / `#0c5cab` | `#0c5cab` / `#97bddf` | 主按钮底色与经对比度校准的链接色 |
| `--highlight` | `#f59e0b` | `#f59e0b` | 台词定位 `#p<n>b<i>` 高亮提示环 |
| `--reader-bg` | `#09090b` | `#09090b` | 漫画阅读器纯黑底衬与半透明台词浮层底色 |

## 3. 排版与双模式配色

- **标题与正文字体栈**：
  - `--font-sans`：`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', 'IBM Plex Sans', 'Microsoft YaHei', system-ui, sans-serif`
  - `--font-serif`：`'Noto Serif SC', 'Songti SC', Georgia, serif`
  - `--font-heading`：受 `appearance.font` 控制，在 `var(--font-sans)` 与 `var(--font-serif)` 间切换。
- **三态明暗系统（`color-scheme.js` + `day-night-control.js`）**：首屏内联脚本读取存储偏好（默认跟随系统），支持在“跟随系统 / 浅色 / 深色”间切换并派发 `pagehaven:color-scheme-change` 事件；右上角昼夜场景开关（`day-night-switch.js`）与之共用同一状态源，脚本未加载时保留原生三态单选入口。

## 4. 阅读画布与动效规范

- **文字层与深链高亮**：台词框（`.box`）按 0–1 相对坐标叠加于漫画页上，背景使用 `--text-overlay`（`rgba(9, 9, 11, 0.88)`）与 `#fafafa` 前景；通过 `/search/` 跳转到 `/<series>/<issue>/<chapter>/#p<n>b<i>` 时高亮对应台词框。
- **本地打包微动效（`page-motion.js`）**：目录卡片与列表使用本地打包的 `animejs` 执行轻量入场动效；遵循 `prefers-reduced-motion: reduce` 立即跳过动画，不影响翻页、台词定位与无脚本阅读。
- **文档站外观约定**：`docs-site/` 文档站点独立于 `packages/site/` 业务站点，使用 VitePress 默认布局搭配自定义主题样式表进行文档呈现。
