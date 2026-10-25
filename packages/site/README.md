# @gallery/site

[返回「页间 · Pagehaven」项目说明](../../README.md)

页间 · Pagehaven 的 Astro 静态站：作品 / 期 / 话页面、阅读器（每话一个 HTML，`#p12` 深链，文字层内嵌）、
搜索页（接线在 `@gallery/search`）。产物在仓库根 `dist/`（`DIST_DIR` 环境变量可覆盖）。

站点默认名称为「页间 · Pagehaven」，可在 `site.config.yaml` 修改。书页图标随静态产物提供。
视觉语言：暖纸白背景、墨蓝标题、青绿按钮与链接、16px 圆角和轻阴影卡片，
衬线标题（`--font-serif`）搭配无衬线正文。表面、交互、选区与阅读标注使用共享语义色变量。
设计 token 全在 `Base.astro` 的 `:root`，各页面只写自己的局部样式；样式随
`inlineStylesheets=always` 内联，dist 里不多出 CSS 文件；字体只用系统栈，不引外部字体请求。

只用 Web 标准 API（CLAUDE.md 铁律 1）：不 import Node 内置模块，Astro 页面的 frontmatter 也算。
数据与配置由构建脚本（`scripts/lib/site-generated.mjs`，Node）在 `astro build` 前写到
`src/generated/`（不入库），页面只 import 那些 JSON：

| 文件 | 内容 |
|---|---|
| `site-config.json` | 校验过的 `site.config.yaml`（`build:config` 与 `build:site` 都会写） |
| `gallery.json` | 作品 / 期 / 话 / 页与图片 key 的结构树，**不含台词框** |
| `text/<series>/<issue>/<chapter>.json` | 每话的台词框 `{ chapter, pages: [{ n, boxes: [{ i, x, y, w, h, t }] }] }`；只给有台词稿的话写，只写有框的页 |

`gallery.json` 里标了 `hasText` 的话，`text/` 下必须有对应分片：文字层开着而分片取不到时，阅读器页
**构建报错退出**（信息含该话 key），不会静默退化成「无文字层」——`npm run check` 只数 HTML，事后抓不到这种丢失。

```bash
npm run build:config   # 先生成 src/generated/site-config.json
npm run build:site     # = 写 gallery.json + text/ → astro build → 平台生成物 + GitHub Pages 基线文件
```

## 页面

| 路由 | 文件 | 说明 |
|---|---|---|
| `/` | `pages/index.astro` | 作品列表（模型顺序：sort 再 title），检索入口 |
| `/<series>/` | `pages/[series]/index.astro` | 期列表：number、title、published、话数 |
| `/<series>/<issue>/` | `pages/[series]/[issue]/index.astro` | 话列表：number、title、页数、「有台词」（只在 `features.text_layer` 开时标——flag 关了阅读器没有文字层，列表不该还承诺） |
| `/<series>/<issue>/<chapter>/` | `pages/[series]/[issue]/[chapter]/index.astro` | 阅读器，见下 |
| `/search/` | `pages/search/index.astro` | 检索页壳；逻辑由 `packages/search` 接入 |
| `/404.html` | `pages/404.astro` | noindex |

外壳 `layouts/Base.astro`：`lang` 取 `site.lang`，页面标题使用 `site.title`，提供 viewport、
纸白墨蓝主题、书页图标与共享内联 CSS。正式页面输出 canonical（`https://<site.domain>` + 路径）
和 `og:title`；404 与预览页面使用 `noindex`，不输出 canonical。导航与页脚均可回首页。不用 UI 框架。
共用的纯函数（图片 URL、百分比坐标、框样式、切源的域名替换）在 `lib/gallery.js`，lint 管得到，
单测在 `test/gallery.test.js`；流水线级的构建测试在 `scripts/test/site-build.test.mjs`。

默认模板没有作品时，首页仍显示站点名称和明确的空目录提示。搜索页分别提示「没有作品」
或「已有作品但尚未收录台词」，两种情况均不下载检索库。

作品 id 不能是 `search` `api` `index` `series` `404` `cname`——它们是站点固定路由或固定文件，
Astro 会静默让静态路由赢；`scripts/lib/site-generated.mjs` 在构建时拦。

## 阅读器

- **可选增强分页**：`features.comimi_reader` 默认关闭；开启后阅读设置提供「增强分页」，由读者自行勾选。
  按需加载同源分页组件，使用原站的 `#p<n>`、每话页码和 `gallery:progress:<chapter key>`，
  不再建立另一套进度数据库。长条、显示文字、`#p<n>b<i>` 台词定位继续走标准阅读器；
  关闭选项或组件加载失败会退回标准阅读器。无 JavaScript 时所有图片和文字仍完整可读。
  页收藏按话保存在 `gallery:favorites:<chapter key>`，与阅读进度分开；存储不可用时仅保留当前会话。
  分享面板沿用站点页码深链，并在外部翻页后同步更新。
  依赖固定版本并随站点构建，不运行时访问第三方脚本 CDN；许可随产物放在 `licenses/comimi.txt`。
  功能开关关闭的页面不加载增强入口，部署目标和响应头不变。
- **每话恰好一个 HTML**：全部页的 `<img src=webp loading="lazy" width height alt>` 都在这一份里，
  URL = `https://<images.hosts[0]>/<key>`。
- **文字层**（`features.text_layer` 为真时输出）：每页一个按 w/h 设 `aspect-ratio` 的定位容器，
  每个框一个绝对定位、透明背景、透明字色、可选中的 `<span class="box" id="p<n>b<i>">`，
  left/top/width/height 用百分比；w=h=0 的点标签画成一个小圆点（`.box.dot`），文本仍可选中。
  文本是普通 DOM 文本，爬虫可见。「显示文字」勾选框把文字层变成可见（`.reader.show-text`）。
- **渐进增强**：初始 DOM 全部页纵向可见；页尾内联脚本一跑，`#reader` 加 `.js`，
  按保存的阅读模式接管（首次默认单页）。
  没有 JS：全部页可读、`#p<n>` 是原生锚点、`#p<n>b<i>` 靠 `:target` 高亮。
- **翻页与阅读模式**：单页 / 长条 / 双页（宽屏两列，视口不超过 48rem 时同一跨页上下排列）；
  方向可切左→右 / 右→左，右→左时跨页的起始页放在右边。左右键、图片点击与滑动按方向映射；
  「上一页 / 下一页」和空格始终按章节顺序。按钮获得焦点时保留其原生键盘操作。
  支持全屏、亮度、页码跳转，f（全屏）、t（目录）、Esc 快捷键。
  亮度过滤仅作用于阅读画面，站点目录和设置保持清晰，并相对视口定位；面板内操作不会翻动背景漫画。
- **进度与目录**：每话读到第几页写 `localStorage`（`gallery:progress:<chapter key>`），
  没有 hash 时自动恢复；长条模式按视口上部的可见页保存，恢复时滚到该页，图片仍由原生 lazy
  按需加载。恢复先等文档解析和布局完成，定位期间不让滚动事件覆盖保存页码。
  滚动按动画帧合并、仅跨页时写存储，离开页面前再同步一次。首页「继续阅读」与
  作品页「继续阅读」读同一份记录。两页都精确匹配当前章节 URL，标题和页数以当前目录为准，
  旧页码限制到现存页范围；坏记录与存储访问失败不影响页面，也不删除旧记录。
- **按需目录**：每话只内嵌作品 / 本期目录链接与当前章标记，首次打开侧栏时加载
  `/index/<series>.json`，成功后在本页复用；并发打开只发一次请求。支持章节筛选、当前章定位，
  请求超时、失败或目录内容不匹配时提供重试与静态目录链接。无 JS 仍能通过上下话和目录导航。
  打开前不会取完整索引，也不把全作品目录重复嵌入每一话。
- **图片状态与重试**：`lib/reader-images.js` 显示每页加载状态，失败时按配置依次尝试不同来源，
  耗尽后停止并提供“重试本页”。提示在图片框外，不遮挡台词和搜索高亮；重试不重置页码和阅读模式。
  模块挂载前已完成或失败的图片也会核对状态；保留原生懒加载，无 JS 时不显示脚本状态控件。
- **hash**：`#p<n>` 打开时定位到第 n 页，翻页时 `history.replaceState` 更新（不刷新、不堆历史）；
  `#p<n>b<i>` 额外高亮第 i 个框（`.hl`）并滚到它——检索结果按这个格式链过来。`hashchange` 也响应。
- **上一话 / 下一话**：模型的 `prev` / `next`（同作品内跨期），URL = `'/' + key + '/'`，
  `rel="prev"` / `rel="next"`，显示对方标题。
- **图片失败切源**：图片模块直接复用 `lib/gallery.js` 的 `swapHost`，只替换已配置来源的域名，
  保留不可变图片路径；正常加载不会访问备用源，手动重试从原始来源开始。
- **上一话 / 下一话的标题**在 `getStaticPaths` 里查一次表放进 props；frontmatter 每话跑一次，不在那里建全站查找表。
- 样式用 `is:global` + `.reader` 前缀而不是作用域样式：作用域样式会给每个台词框加一个
  `data-astro-cid` 属性，18 000 话下是几十 MB 的无用字节。
- `test/reader.test.js` 在 DOM 夹具中执行页面真实内联脚本，覆盖两种方向的按钮/键盘/点击/滑动、
  双页边界、长条恢复与滚动保存；随 `npm test` 运行。宽窄屏的实际两列排版仍需浏览器验收。

## 搜索页的约定 id

| id | 元素 | 用途 |
|---|---|---|
| `search-form` | `<form method="get" action="/search/">` | 没有 JS 时提交只是把 `q` 留在 URL 里 |
| `search-input` | `<input name="q" type="search">` | 输入框 |
| `search-status` | `<p aria-live="polite">` | 「检索库加载中 / 暂不可用」等状态 |
| `search-results` | `<ol>` | 结果列表；每条链到 `/<series>/<issue>/<chapter>/#p<n>b<i>` |
| `search-config` | `<script type="application/json">` | `images.hosts`、`db.*`、`search.*`、`features.search_function` |
