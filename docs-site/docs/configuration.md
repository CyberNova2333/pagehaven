# 配置、数据与前端契约

Pagehaven 使用 `site.config.yaml` 作为唯一配置真相源（SSOT），通过 `@gallery/platform` 验证后同时驱动数据构建、SQLite 建库、Astro 页面渲染与多平台配置文件生成。

## 1. `site.config.yaml` 配置规范

| 顶层字段 | 关键配置项 | 默认值与约束 | 作用说明 |
| --- | --- | --- | --- |
| `site` | `title`、`domain`、`lang`、`tagline`、`logo` | `domain` 默认 `gallery.example.org`（生产发布禁止示例域名） | 网站名称、canonical/sitemap 源域名与 HTML 语言属性 |
| `appearance` | `theme`、`accent`、`font`、`show_search`、`show_library` | `theme`: `paper` \| `ocean` \| `plum`；`font`: `sans` \| `serif` | 派生 `--bg-*`/`--accent`/`--font-heading` 等有限语义变量，禁用任意 CSS |
| `images` | `hosts`、`prefix` | 1–2 个有效 CDN 主机；`prefix` 默认 `img/`（安全 ASCII 前缀） | 阅读器图片与前端检索库读取域名与路径前缀 |
| `db` | `page_size`、`chunk_size`、`prefix`、`whole_download_max_bytes` | `page_size`: `4096`；`chunk_size`: `65536`；`prefix`: `db/`；上限 `31457280` | 控制 SQLite 页对齐、分块清单粒度及浏览器端整库下载保护上限 |
| `search` | `request_chunk_size`、`min_match_length`、`api_path` | 块大小 `4096`（须与 `db.page_size` 一致）；最短触发词 `2` 字 | 前端检索页配置；`api_path` 默认 `/api/search` 仅在 `search_function: true` 时启用 |
| `features` | `search_function`、`platform_config`、`text_layer`、`comimi_reader` | 默认 `false`、`true`、`true`、`false` | 控制纯静态平台配置文件生成、阅读器台词文字层与 `@yui540/comimi` 可选分页 |
| `budgets` | `max_files`、`max_file_bytes` | 默认 `18000` 文件、`20971520` 字节（20 MiB） | 全站通用静态输出安全预算守卫 |
| `headers` / `redirects` | HTTP 响应头映射与 301/302 跳转表 | 重定向源须为合法站内路径，目标严格限制在输出目录内 | 生成 `_headers`、`_redirects`、`edgeone.json` 与纯静态跳转 HTML |
| `seo` | `indexnow_key` | `null` 或 `8–128` 位 `[A-Za-z0-9-]` | 非空时在 `dist/` 根目录写入 `<key>.txt` 并允许 `push:search` 推送新增 URL |
| `deploy` | `cloudflare.project`、`edgeone.project`、`github.cname`、`workers`、`esa` | 目标项目定位字段与自定义域名绑定 | 由 `build:config` 同步生成到 `packages/platform/generated/` |

### 生成物分类边界（`@gallery/platform`）

- **`GENERATED_FILES`**（受 `features.platform_config` 控制进入 `dist/`）：`_headers`、`_redirects`、`edgeone.json`。
- **`DEPLOY_CONFIG_FILES`**（生成在 `packages/platform/generated/` 供发布工具读取，**严禁复制进 `dist/`**）：`wrangler.jsonc`、`esa.jsonc`。

## 2. 内容目录与数据模型契约（`@gallery/core`）

作品数据组织在 `data/`（可通过 `DATA_DIR` 覆盖）：

```text
data/
├── meta/
│   ├── <series>/series.yaml          # SeriesSchema（标题、排序 sort、作者、标签、封面 hash 等）
│   └── <series>/<issue>.yaml         # IssueSchema（刊期号 number、chapters 数组与每页宽高/webp 对象 key）
├── text/
│   └── <series>/<issue>/<chapter>.json  # ChapterTextSchema（每页 boxes[]：x, y, w, h ∈ [0,1], text）
└── raw/
    ├── labelplus/<series>/<issue>/<chapter>.txt   # LabelPlus 1,0 翻译原稿
    └── ocr/<series>/<issue>/<chapter>.json        # 人工校对后的 OCR 来源稿
```

核心校验证规则（`packages/core/src/schema.js` & `object-path.js`）：
- ID 标识符（`series` / `issue` / `chapter`）必须为安全短标识，保证路径 `<series>/<issue>/<chapter>/` 合法且无冗余段；
- 页面坐标框（`x`, `y`, `w`, `h`）均使用 `[0, 1]` 归一化小数比例，自动适配任意视口与响应式图片尺寸；
- 图片键与目录前缀必须满足 `isSafeObjectKey` / `isSafeObjectPrefix`（如 `img/<series>/cover-<hash12>.webp`、`img/<series>/<issue>/<n>-<hash12>.webp`）。

## 3. 台词稿导入与人工校对契约

### LabelPlus 翻译稿导入（`pnpm run ingest:labelplus`）

解析 `data/raw/labelplus/<series>/<issue>/<chapter>.txt`：
- 严格识别官方分隔符：`>>>>>>>>[文件名]<<<<<<<<` 与 `----------------[编号]----------------[x,y,分组]`，避免误吞台词正文里的 `————` 或 `>>>` 装饰线；
- 支持页码映射策略 `LABELPLUS_PAGES=auto|number|sequence`，对格式可疑的行输出带 1 起行号的 `warnings`（⚠），不悄悄丢失台词；
- 支持 `--dry-run` 预览新增/更新/未变章节及全部诊断，以及 `CHAPTERS=s1/i1/c1,s1/i1/c2` 按话增量过滤。

### OCR 辅助与人工门禁（`pnpm run ingest:ocr`）

`ingest:ocr` 为保护全站全文检索质量，采用**强制人工校对双阶段门禁**：
1. **生成草稿（默认）**：必须指定 `CHAPTERS`，产出待校对 JSON 与图文对照 HTML 到 `OUT_DIR`（**绝不写入 `data/text/`**）；
2. **显式接受**：维护者手工校对后放入 `data/raw/ocr/...`，再次运行 `CHAPTERS=... pnpm run ingest:ocr -- --accept-reviewed` 才会校验并写入 `data/text/` 参与检索库构建。

## 4. 浏览器端检索与阅读器契约

### 检索页 DOM 与配置约定（`/search/`）

页面元素 ID 由 `packages/site/src/pages/search/index.astro` 与 `packages/search/src/mount.js` 共同锁定，二次定制时不可随意删除或改名：
- `#search-config`（`<script type="application/json">`）：内嵌 `images.hosts`、`db` 参数、`db.release`（构建期固定的 `{ version, key, size, sha256, pageSize, chunkSize, chunks }`）、`search` 参数与 `coverage`（`chapters` / `withText` / `boxes`）；
- `#search-form` / `#search-input` / `#search-series` / `#search-status` / `#search-coverage` / `#search-results` / `#search-more`；
- `#meta-form` / `#meta-q` / `#meta-results`（请求同源 `/index/series.json` 做作品名/作者/标签过滤，不下载 SQLite 库）。

### 深链定位与本地存储键约定

- **页面与气泡深链**：`/<series>/<issue>/<chapter>/#p<n>` 跳转到第 `n` 页；`/<series>/<issue>/<chapter>/#p<n>b<i>` 打开阅读器文字层高亮提示第 `n` 页第 `i` 个气泡框；
- **浏览器存储键**：书架状态（`gallery:library:*`）、阅读进度（`gallery:progress:*`）、书签（`gallery:favorites:*`）与备注（`gallery:note:*`，单条 ≤ 200 字）、增强分页开关（`gallery:reader:enhanced`）、深浅主题偏好（`gallery:color-scheme`）均受各自模块与 `pagehaven-reading-backup` v1（5 MiB / 20,000 条）备份契约约束。
