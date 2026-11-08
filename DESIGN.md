# 设计系统灵感与指南：PageHaven

## 1. 视觉主题与氛围

PageHaven 是面向长文连载、多刊期（Series / Issue / Chapter）归档与沉浸式阅读的静态出版工作台。其视觉语言与 CloudForge 同属 **GitHub Primer 功能主义设计体系**，将 Primer 的结构化文档容器（`Box`、`UnderlineNav`、`CounterLabel`）与高可读性的长文排版体验无缝融合。

整体气质克制、干净、层次分明：通过 `canvas.inset`（浅色 `#f6f8fa` / 深色 `#010409`）顶部导航栏与底栏、`canvas.default`（浅色 `#ffffff` / 深色 `#0d1117`）主阅读画布、以及 `canvas.subtle`（浅色 `#f6f8fa` / 深色 `#161b22`）的系列目录卡片标题栏，建立清晰的「书架导览 — 刊期索引 — 章节正文」三级空间结构。

**核心特征：**
- **四级功能性画布（Functional Canvas Hierarchy）**：拒绝廉价的大面积渐变、毛玻璃卡片与悬浮大阴影，依靠 `1px solid` 语义化边框（浅色 `#d0d7de` / 深色 `#30363d`）与 `canvas.default` / `canvas.subtle` / `canvas.inset` 的明度层级组织长文目录与阅读器辅助面板。
- **双轨字体架构（Editorial + UI Dual Stack）**：界面导航、检索控制栏与章节元数据采用高可读性的无衬线 UI 字体栈；章节正文支持衬线（Serif）与无衬线（Sans）切换，阅读器控制条支持字号、行高与行宽实时调节。
- **Primer 蓝色语义焦点（Primer Functional Blue）**：当前阅读章节、激活的检索过滤标签、阅读进度条与焦点环统一使用 Primer 功能蓝（浅色 `#0969da` / 深色 `#2f81f7`）。
- **无干扰沉浸阅读（Distraction-Free Reading Mode）**：顶部进度条高度压缩至 `2px`，阅读器控制栏与书签抽屉收纳在紧凑的 Primer `Box` 浮层中，确保阅读视线不被厚重边框打断。

---

## 2. 调色板与色彩角色

PageHaven 严格对齐 GitHub Primer 功能性设计令牌，同时在 `site-appearance.js` 中将站点外观变量映射到统一的浅色/深色语义角色：

### 画布背景（Canvas）
- **主画布（`canvas.default` / `--bg`）**：浅色 `#ffffff` · 深色 `#0d1117` —— 主页面与章节正文阅读区背景
- **浮层画布（`canvas.overlay` / `--bg-elevated`）**：浅色 `#ffffff` · 深色 `#161b22` —— 系列卡片、阅读器设置面板与书签抽屉背景
- **内嵌画布（`canvas.inset`）**：浅色 `#f6f8fa` · 深色 `#010409` —— 顶部全局导航栏、页脚与代码块内嵌底色
- **柔和画布（`canvas.subtle` / `--accent-soft`）**：浅色 `#f6f8fa` · 深色 `#161b22` —— `Box-header` 标题栏、检索输入区与列表悬停背景

### 文本前景（Foreground）
- **主文本（`fg.default` / `--text`）**：浅色 `#1f2328` · 深色 `#f0f6fc` —— 标题、正文与主要导航文字
- **次级文本（`fg.muted` / `--muted`）**：浅色 `#57606a` · 深色 `#8b949e` —— 刊期摘要、字数/阅读时长统计、面包屑次级项
- **弱化文本（`fg.subtle`）**：浅色 `#6e7781` · 深色 `#6e7681` —— 快捷键提示、输入框占位符与章节编号前缀
- **强调面文本（`fg.onEmphasis`）**：`#ffffff` —— 实心主按钮与高亮计数徽章文字

### 交互与品牌主色（Accent / Primary）
- **链接与主交互色（`accent.fg` / `--accent`）**：浅色 `#0969da` · 深色 `#2f81f7` —— 章节链接、激活导航项、阅读进度指示与焦点环
- **主按钮实心填充（`accent.emphasis`）**：浅色 `#0969da` · 深色 `#1f6feb` —— 「开始阅读」「跳至最新章节」等主操作按钮
- **主按钮悬停（`accent.hover`）**：浅色 `#0860ca` · 深色 `#388bfd`
- **主色柔和背景（`accent.subtle`）**：浅色 `#ddf4ff` · 深色 `rgba(56, 139, 253, 0.15)` —— 激活分类标签、当前章节高亮行背景

### 语义状态角色（Semantic Roles）
- **连载完结 / 已读（`success`）**：前景 `#1a7f37`（浅）/ `#3fb950`（深），柔和背景 `#dafbe1`（浅）/ `rgba(46, 160, 67, 0.15)`（深）
- **连载更新中 / 书签标记（`attention`）**：前景 `#9a6700`（浅）/ `#d29922`（深），柔和背景 `#fff8c5`（浅）/ `rgba(187, 128, 9, 0.15)`（深）
- **删除 / 清空记录（`danger`）**：前景 `#cf222e`（浅）/ `#f85149`（深），柔和背景 `#ffebe9`（浅）/ `rgba(248, 81, 73, 0.15)`（深）

### 边框与分隔线（Borders）
- **默认结构边框（`border.default` / `--border`）**：浅色 `#d0d7de` · 深色 `#30363d` —— 系列卡片外框、导航栏底边与输入框边框
- **柔和内部分隔线（`border.muted`）**：浅色 `#d8dee4` · 深色 `#21262d` —— 刊期内部章节列表行分隔线

---

## 3. 排版与字阶体系

### 字体栈（Font Stack）
- **UI 与目录无衬线字体（`--font-ui`）**：
  ```css
  -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif
  ```
- **长文阅读衬线字体（`--font-body`）**：
  ```css
  "Iowan Old Style", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif
  ```
- **等宽字体（`--font-mono`）**：
  ```css
  ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace
  ```

### 字阶与行高规范（Type Scale）
| 角色 | 字号 | 行高 | 字重 | 典型场景 |
| :--- | :--- | :--- | :--- | :--- |
| **章节大标题（Chapter Title）** | `24px` (`1.5rem`) | `1.3` | `600` | 阅读页章节主标题 |
| **页面标题（Page Heading / H1）** | `20px` (`1.25rem`) | `1.3` | `600` | 书架首页标题、系列详情页标题 |
| **分节标题（Section Heading / H2）** | `16px` (`1rem`) | `1.4` | `600` | 系列卡片标题、刊期分组标题 |
| **长文正文（Reading Body）** | `16px–20px`（可调） | `1.75` | `400` | 章节正文段落（行宽限制 `65ch–72ch`） |
| **UI 标准正文（UI Body）** | `14px` (`0.875rem`) | `1.5` | `400` / `500` | 导航栏、章节列表、检索结果摘要、按钮文案 |
| **辅助元数据（Meta / Small）** | `12px` (`0.75rem`) | `1.4` | `400` / `600` | 刊号、字数统计、快捷键提示、胶囊徽章 |

- **数字对齐**：章节序号、字数统计、阅读进度百分比统一启用 `font-variant-numeric: tabular-nums`。

---

## 4. 布局、空间与网格系统

- **基准间距单位**：`8px` 空间步进（`4px`、`8px`、`12px`、`16px`、`24px`、`32px`）。
- **页面容器宽度**：
  - **书架与检索工作区（`.site-shell`）**：最大宽度 `1120px`，水平内边距 `24px`（移动端 `16px`）。
  - **章节正文阅读区（`.reader-article`）**：居中单栏布局，正文排版行宽控制在 `68ch`（约 `680px–740px`），两侧留白充足。
- **顶部全局导航栏（`.site-header`）**：
  - 高度 `56px`，背景使用 `canvas.inset`，底部 `1px solid var(--border)`。
  - 左侧为站点标识与主导航链接，右侧为快速检索入口与浅色/深色主题切换按钮。
- **圆角规范**：
  - 标准容器（Primer `Box`、系列卡片、阅读控制栏）：`6px`
  - 紧凑控件（快捷键标签 `kbd`、小按钮）：`4px`
  - 状态与标签胶囊（Badge / Tag）：`9999px`

---

## 5. 核心组件规范

### 5.1 系列与刊期容器（Primer `Box`）
- **外框**：`background: var(--bg-elevated)`，`border: 1px solid var(--border)`，`border-radius: 6px`，浅色模式下带 `0 1px 0 rgba(27, 31, 35, 0.04)` 静息底影。
- **卡片头部（Box Header）**：`background: var(--canvas-subtle)`，`padding: 12px 16px`，`border-bottom: 1px solid var(--border)`，展示系列标题、连载状态胶囊与刊期计数。
- **章节行列表（Box Rows）**：每行 `padding: 10px 16px`，行间以 `1px solid var(--border-muted)` 分隔；悬停时背景切换为 `var(--canvas-subtle)`，章节标题变更为 `var(--accent)`。

### 5.2 按钮与阅读器工具条（Buttons & Reader Controls）
- **高度与内边距**：标准控件高度 `32px`，内边距 `5px 12px`，`border-radius: 6px`，`font-size: 14px`，`font-weight: 500`。
- **Default Button**：`background: var(--canvas-subtle)`，`border: 1px solid var(--border)`，文本 `var(--text)`。
- **Primary Button**：`background: var(--accent-emphasis)`，`color: #ffffff`，悬停 `var(--accent-hover)`。
- **阅读器控制栏（Reader Toolbar）**：采用紧凑的 Primer 分段按钮组（Segmented Control）调节字号（`A-` / `A+`）、字体族（衬线 / 无衬线）与书签抽屉开关。

### 5.3 书签抽屉与全文检索（ReaderBookmarks & Search）
- **检索输入框**：高度 `32px`（首页主检索框 `36px`），`background: var(--bg)`，`border: 1px solid var(--border)`，`border-radius: 6px`；聚焦时边框变为 `var(--accent)` 并呈现 `0 0 0 3px var(--accent-subtle)` 焦点环。
- **书签与继续阅读条**：采用 Primer `Box` 内嵌列表结构，清晰标注上次阅读章节、时间戳与一键跳转动作。

---

## 6. 动效、无障碍与工程约束

- **克制过渡**：仅对颜色、边框与背景色应用 `120ms cubic-bezier(0.2, 0, 0.38, 0.9)` 过渡；严禁对卡片使用悬停上浮（`translateY`）或弥散发光阴影。
- **减少动态效果**：完整支持 `@media (prefers-reduced-motion: reduce)`，禁用平滑滚动与过渡动画。
- **键盘无障碍**：所有交互元素具备清晰的 `:focus-visible` 焦点环（`2px solid var(--accent)`，`outline-offset: 2px`），保留 `.skip-link` 跳转主内容链接。
- **测试契约兼容**：`site-appearance.js` 导出的 CSS 自定义属性名（`--bg`、`--bg-elevated`、`--text`、`--muted`、`--accent`、`--accent-soft`、`--border`、`--shadow`、`--font-body`、`--font-ui`）必须保持完整兼容。
