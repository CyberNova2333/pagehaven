# @gallery/site

Astro 静态站：作品 / 期 / 话页面、阅读器（每话一个 HTML，`#p12` 深链，文字层内嵌）、
搜索页壳。产物在仓库根 `dist/`（`DIST_DIR` 环境变量可覆盖）。

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

外壳 `layouts/Base.astro`：`lang` 取 `site.lang`，`<title>`、viewport、深色主题、极简内联 CSS、
每页 canonical（`https://<site.domain>` + 路径）与 `og:title`，页脚一行回首页。不用 UI 框架。
共用的纯函数（图片 URL、百分比坐标、框样式、切源的域名替换）在 `lib/gallery.js`，lint 管得到，
单测在 `test/gallery.test.js`；流水线级的构建测试在 `scripts/test/site-build.test.mjs`。

作品 id 不能是 `search` `api` `index` `series` `404` `cname`——它们是站点固定路由或固定文件，
Astro 会静默让静态路由赢；`scripts/lib/site-generated.mjs` 在构建时拦。

## 阅读器

- **每话恰好一个 HTML**：全部页的 `<picture>`（`<source type="image/avif">` + `<img src=webp
  loading="lazy" width height alt>`）都在这一份里，URL = `https://<images.hosts[0]>/<key>`。
- **文字层**（`features.text_layer` 为真时输出）：每页一个按 w/h 设 `aspect-ratio` 的定位容器，
  每个框一个绝对定位、透明背景、透明字色、可选中的 `<span class="box" id="p<n>b<i>">`，
  left/top/width/height 用百分比；w=h=0 的点标签画成一个小圆点（`.box.dot`），文本仍可选中。
  文本是普通 DOM 文本，爬虫可见。「显示文字」勾选框把文字层变成可见（`.reader.show-text`）。
- **渐进增强**：初始 DOM 全部页纵向可见；页尾内联脚本一跑，`#reader` 加 `.js`，切成单页模式。
  没有 JS：全部页可读、`#p<n>` 是原生锚点、`#p<n>b<i>` 靠 `:target` 高亮。
- **翻页**：键盘 ← 上一页、→ 下一页；点击页面左半 / 右半（正在选文字或点在框上时不翻）；
  「上一页 / 下一页」链接；页码显示 `第 <#page-cur> / N 页`。
- **hash**：`#p<n>` 打开时定位到第 n 页，翻页时 `history.replaceState` 更新（不刷新、不堆历史）；
  `#p<n>b<i>` 额外高亮第 i 个框（`.hl`）并滚到它——检索结果按这个格式链过来。`hashchange` 也响应。
- **上一话 / 下一话**：模型的 `prev` / `next`（同作品内跨期），URL = `'/' + key + '/'`，
  `rel="prev"` / `rel="next"`，显示对方标题。
- **图片失败切源**：一段内联脚本捕获 `<img>` 的 `error`，把 `<source srcset>` 与 `<img src>` 的域名从
  `images.hosts[0]` 换成 `images.hosts[1]`（若有）再试一次，每张只试一次。替换规则与 `lib/gallery.js`
  的 `swapHost` 是同一条（内联脚本没法 import，各留一份，改一处要同步另一处）。
- **上一话 / 下一话的标题**在 `getStaticPaths` 里查一次表放进 props；frontmatter 每话跑一次，不在那里建全站查找表。
- 样式用 `is:global` + `.reader` 前缀而不是作用域样式：作用域样式会给每个台词框加一个
  `data-astro-cid` 属性，18 000 话下是几十 MB 的无用字节。

## 搜索页的约定 id

| id | 元素 | 用途 |
|---|---|---|
| `search-form` | `<form method="get" action="/search/">` | 没有 JS 时提交只是把 `q` 留在 URL 里 |
| `search-input` | `<input name="q" type="search">` | 输入框 |
| `search-status` | `<p aria-live="polite">` | 「检索库加载中 / 暂不可用」等状态 |
| `search-results` | `<ol>` | 结果列表；每条链到 `/<series>/<issue>/<chapter>/#p<n>b<i>` |
| `search-config` | `<script type="application/json">` | `images.hosts`、`db.*`、`search.*`、`features.search_function` |
