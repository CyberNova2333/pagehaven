# 设计系统指南：PageHaven 出版级质感设计系统

## 1. 视觉主题与设计哲学

PageHaven 是面向长文连载、多刊期（Series / Issue / Chapter）归档与沉浸式阅读的静态出版工作台。其设计语言以 **GitHub Primer 功能主义架构** 为骨架，深度融合 **出版级物理质感设计系统（Editorial & Tactile Materiality Design System）**。

整体设计拒绝廉价浮夸的大面积渐变、虚无的毛玻璃弥散与悬浮大阴影，强调：
- **物理分层光影（Directional Key Light & Ambient Occlusion）**：采用 `1px solid` 语义化结构边框搭配顶边缘物理倒角微高光（`inset 0 1px 0 rgba(255, 255, 255, 0.6)`），形成温润内敛的书籍装帧与工作台边框层次。
- **物理纸张纤维与微纹理底质（Paper Grain & Tactile Grounding）**：主阅读画布与卡片提供细腻的物理纸质底衬（温润纸白、羊皮护眼米黄、午夜黑金、极简深灰），构建书籍与刊物的实体触感。
- **触感反馈与物理回弹按键（Tactile Press Mechanics）**：所有按钮、标签胶囊与阅读控制器具备真实的物理下沉与阻尼回弹反馈（`:hover` 时微浮 `-0.5px`，`:active` 时下沉 `+0.5px scale(0.99)` 并加深 `inset 0 2px 4px` 凹陷底影）。
- **双轨字体排版体系（Editorial Serif + Modern UI Sans）**：界面导航与检索控制采用高清晰度无衬线字体，章节长文正文提供衬线体（Serif）与无衬线体无缝切换，行高严格锁定黄金阅读比例（`1.75`）。
- **双模式无缝切换（质感出版物模式 vs 极简纯净模式）**：既可享受温润书卷气与立体压印装帧，亦可一键切换至专注文档的高对比纯净极简布局。

---

## 2. 调色板与语义令牌

PageHaven 严格遵守 GitHub Primer 的功能性色彩角色，并在深浅双模下经过精确的光学对比度与微质感校准（WCAG AA）：

### 2.1 画布层级（Canvas Hierarchy）
| 变量名 | 浅色模式（温润纸白） | 深色模式（深邃午夜） | 物理质感与典型用途 |
| :--- | :--- | :--- | :--- |
| `canvas.default` / `--bg` | `#ffffff` | `#0d1117` | 主页面背景与章节长文阅读底纸 |
| `canvas.overlay` / `--bg-elevated` | `#ffffff` | `#161b22` | 系列卡片浮层、阅读器设置抽屉与书签面板 |
| `canvas.inset` | `#f6f8fa` | `#010409` | 顶部导航栏底色、代码块内嵌区与书籍外框 |
| `canvas.subtle` / `--accent-soft` | `#f6f8fa` | `#161b22` | 卡片表头（`Box-header`）、检索栏与悬停底色 |
| `canvas.muted` | `#eaeef2` | `#21262d` | 禁用态、分割线槽底与辅助标签底色 |

### 2.2 前景与文本（Foreground）
| 变量名 | 浅色模式 | 深色模式 | 典型用途 |
| :--- | :--- | :--- | :--- |
| `fg.default` / `--text` | `#1f2328` | `#f0f6fc` | 标题、章节长文正文与主要阅读文字 |
| `fg.muted` / `--muted` | `#57606a` | `#8b949e` | 刊号副标题、字数统计、阅读时长与辅助元数据 |
| `fg.subtle` | `#6e7781` | `#6e7681` | 输入框占位符、快捷键提示与页码前缀 |
| `fg.onEmphasis` | `#ffffff` | `#ffffff` | 强调色实心主按钮与高亮胶囊文字 |

### 2.3 语义色彩与质感状态（Semantic Roles）
- **Primer 功能蓝（Accent）**：浅色 `#0969da` · 深色 `#2f81f7` —— 阅读进度指示条、激活章节高亮、焦点环。
- **已读 / 完结（Success）**：浅色 `#1a7f37`（底 `#dafbe1`） · 深色 `#3fb950`（底 `rgba(46, 160, 67, 0.15)`）—— 连载完结胶囊、书签已存。
- **连载中 / 提示（Attention）**：浅色 `#9a6700`（底 `#fff8c5`） · 深色 `#d29922`（底 `rgba(187, 128, 9, 0.15)`）—— 刊期更新中标记。
- **异常 / 移除（Danger）**：浅色 `#cf222e`（底 `#ffebe9`） · 深色 `#f85149`（底 `rgba(248, 81, 73, 0.15)`）—— 清除阅读历史、报错状态。

### 2.4 边框与双层光影（Borders & Tactile Shadows）
- **结构边框**：浅色 `#d0d7de` · 深色 `#30363d`（`1px solid`）
- **微倒角高光**：
  - 浅色：`inset 0 1px 0 rgba(255, 255, 255, 0.6)`
  - 深色：`inset 0 1px 0 rgba(255, 255, 255, 0.08)`
- **按压下凹阴影**：`inset 0 2px 4px rgba(0, 0, 0, 0.16)`
- **多层环境投影**：
  - 卡片静息：`0 1px 3px rgba(31, 35, 40, 0.05), 0 1px 0 rgba(31, 35, 40, 0.03)`
  - 卡片浮起：`0 4px 12px rgba(31, 35, 40, 0.08), 0 1px 3px rgba(31, 35, 40, 0.04)`

---

## 3. 排版与出版级字阶体系

### 3.1 字体栈（Typography Stack）
- **UI 导航与控制栏（`--font-sans`）**：
  ```css
  -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "IBM Plex Sans", "Microsoft YaHei", sans-serif
  ```
- **沉浸长文阅读衬线体（`--font-serif`）**：
  ```css
  "Iowan Old Style", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif
  ```
- **代码与数据等宽体（`--font-mono`）**：
  ```css
  ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace
  ```

### 3.2 字阶规范（Type Scale）
| 角色 | 字号 | 行高 | 字重 | 规范要求 |
| :--- | :--- | :--- | :--- | :--- |
| **章节大标题（H1）** | `24px` | `1.25` | `600` | 负字距 `-0.01em`，物理压纹感底边线 |
| **刊期/分节标题（H2）** | `16px` | `1.4` | `600` | 结构化目录分组 |
| **长文正文（Reading Body）** | `16px–20px` | `1.75` | `400` | 行宽严格限制在 `65ch–72ch`（最佳视线追踪跨度） |
| **UI 标准文本** | `14px` | `1.5` | `500` | 导航链接、按钮文本、书签列表 |
| **辅助元数据** | `12px` | `1.4` | `400` | 启用 `tabular-nums`，数字与字数严格对齐 |

---

## 4. 核心触感组件规范

### 4.1 出版级系列卡片（Primer Box with Tactile Edge）
- **外框**：`border: 1px solid var(--border-default); border-radius: 8px; background: var(--canvas-default);`
- **光影**：静息时底影 `0 1px 3px rgba(31, 35, 40, 0.05)`，上边框内侧带微高光线，悬停时产生物理抬升感（`transform: translateY(-1px)`）。
- **Box Header**：`background: var(--canvas-subtle); padding: 12px 16px; border-bottom: 1px solid var(--border-muted);`，展示系列刊号、连载状态胶囊与更新日期。

### 4.2 触感回弹按钮（Tactile Buttons）
- **次级按钮（`.btn`）**：
  - 背景：`linear-gradient(180deg, var(--canvas-default) 0%, var(--canvas-subtle) 100%)`
  - 阴影：`box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6), 0 1px 2px rgba(31, 35, 40, 0.06);`
  - 按下反馈：`transform: translateY(0.5px) scale(0.99); box-shadow: inset 0 2px 4px rgba(31, 35, 40, 0.16);`
- **主要按钮（`.btn-primary`）**：
  - 背景：Primer Blue 线性渐变，高亮边框微倒角高光。
  - 按下反馈：深度下沉与内凹投影。

### 4.3 书签与进度胶囊（Embossed Bookmarks & Pills）
- **胶囊标签（`.pill`）**：`border-radius: 9999px;`，微压印内高光，激活态显示实心焦点底色与微弱外晕光。
- **书签压槽**：目录列表项 hover 时呈现平滑的色块高亮，左侧具备物理厚度的指示条。

---

## 5. 微动效与交互律动

- **物理弹簧曲线**：微动效采用自然阻尼贝塞尔曲线 `cubic-bezier(0.2, 0, 0.38, 0.9)`，禁用机械线性匀速动画。
- **阅读器翻页与跳转**：页面平滑渐显并提供 `180ms` 物理淡入，翻页前后滚动位置精准平顺锚定。
- **减弱动态选项（prefers-reduced-motion）**：无缝尊重系统无障碍偏好，强制瞬时切换。
