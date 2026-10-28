# ARCHITECTURE.md — 技术档案与决策

[返回「页间 · Pagehaven」项目说明](../README.md)

> 本文件记录**是什么、为什么**。规范（必须怎么做）在 `CLAUDE.md` / `AGENTS.md`，
> 改了这里的决策要同步改那边的规则，反之亦然。
> 每节末尾的「决策记录」按时间追加，不删旧条目。

## 0. 目标与约束

**页间 · Pagehaven** 是通用的公开静态漫画站点：作品 / 期 / 话 / 页浏览；期数等元数据检索；台词
（画面文字）**子串级**全文检索；自动 sitemap；台词以可选中的文字层叠在图片上，
同时对爬虫可见。

四条硬约束，优先级从高到低：

1. **三平台快速流转**：Cloudflare Pages、EdgeOne Makers、GitHub Pages 之间 30 分钟
   内整体切换。GitHub Pages 是最小公分母——没有自定义响应头、没有重定向、
   没有函数——站点在这种条件下必须完整可用。
2. **弃维护后仍能存活**：维护者可能长期不再操作。账号级依赖只允许域名、R2、
   至少一个 CDN 账号三处。
3. **全部免费层**：静态优先，函数只作可选加速。
4. **维护者没有电脑**：一切操作只在手机浏览器、GitHub App、Codespaces 里完成。

非目标：用户系统、评论、在线上传后台、服务端渲染。VPS 被明确排除——月付停了、
系统没人打补丁，它比任何免费边缘平台死得都快。

## 1. 架构

```
原始稿 (LabelPlus txt / 人工校对的 OCR JSON)
        │  ingest（LabelPlus 可在发布流水线里导入；OCR 草稿须校对并显式接受）
        ▼
data/meta/*.yaml + data/text/<series>/<issue>/<chapter>.json ← 仓库（公开）
        │  build（CNB 云原生构建；Makers 构建机仅作纯静态构建备用）
        ▼
dist/            静态 HTML(每话一文件，内嵌文字层) + 元数据索引 JSON 分片 + sitemap.xml
gallery.sqlite   FTS5 trigram 台词库；manifest.json；dist 归档
        │
        ├─ dist ──────────→ Cloudflare Pages | EdgeOne Makers | GitHub Pages（三选一，CNAME 切换）
        └─ 图片/DB/归档 ──→ Cloudflare R2（私有桶，唯一持久数据源）
                               └─ 图片域名 img.<domain>：EdgeOne + ESA，CNAME 接入，
                                  以 S3 私有回源（SigV4）读 R2；所有读取都经这里
浏览器端检索：sqlite-wasm 经 CDN 整库下载并校验 sha256，零服务端（Range VFS 尚未接入）
```

**R2 是唯一的真实数据源，且永远私有。** 读取一律经 CDN 域名——CDN 持有回源
凭据，站点、浏览器、GitHub Pages 都不需要知道 R2 的存在；写入只发生在 CI 里。
仓库里的 `data/` 是可再生的输入，`dist` 是可再生的产物，任何托管平台都只是缓存。
Makers Blob / KV、Cloudflare D1 一律不作为必需依赖。

## 2. 预算（`npm run check` 里那些数字的来历）

| 限制 | Cloudflare Pages | EdgeOne Makers（免费版） | GitHub Pages |
|---|---|---|---|
| 单站文件数 | 20 000 | 20 000 | — |
| 单文件 | 25 MiB | 25 MB | 100 MB（git） |
| 站点总量 | — | 5 GB（含历史部署） | 1 GB（软限） |
| 构建 | 500 次/月（不用它） | 500 次/月、20 分钟、4C6G | 10 次/小时 |
| 函数 | Workers 运行时 | Edge 5 MB 包、300 万 ms CPU/月；Cloud 128 MB 包、30–120 s | 无 |

结论：**每话一个 HTML**（阅读器内翻页，`#p12` 深链）而不是每页一个；元数据索引
按作品分片；图片和 DB 绝不进 dist；守卫线取 18 000 文件 / 20 MB 留余量。
Edge Functions 的 CPU 配额小到放不下任何检索逻辑，所以函数版检索只能在
Cloudflare Workers 或 Makers Cloud Functions，且永远可选。

## 3. 三平台矩阵

发布环境约定：三个目标的页面都绑定构建时的检索库版本，上传只产生不可变资源。
生产部署全部成功后才启用共享版本指针、写发布状态及通知搜索引擎；预览和仅上传不执行这些步骤。
GitHub Pages 当前没有独立预览目标，`preview` 配合 `github` 或 `all` 必须在上传前拒绝。
预览页面带 `noindex`，生产发布拒绝示例域名。平台适配变更仍须通过手动预览部署验收。
GitHub Pages 推送后需通过 Pages API 确认本次提交构建成功，再记录部署成功；发布凭据需要
Pages 读取权限，页面发布来源必须是 `gh-pages` 根目录。

| | Cloudflare Pages | EdgeOne Makers | GitHub Pages |
|---|---|---|---|
| 部署 | `wrangler pages deploy dist` | `edgeone makers deploy`（上传 dist；`edgeone pages` 为兼容命令） | 流水线把 dist 推到 `gh-pages` 分支（`GITHUB_PAGES_REPO` / `GITHUB_PAGES_TOKEN`），Pages 发布源指到该分支 |
| 配置生成物 | `dist/_headers`、`dist/_redirects` | `edgeone.json`（headers ≤ 30，redirects/rewrites ≤ 100） | 无；`.nojekyll`、`CNAME`、`404.html`，重定向用 `<meta http-equiv="refresh">` |
| 函数入口 | `functions/`（Workers 运行时，`export default { fetch }`） | `edge-functions/`（isolate，`onRequest`）、`cloud-functions/`（真 Node） | 无 |
| 可选增强分页 | 同源浏览器模块，纯静态可用 | 同左 | 同左；不依赖自定义响应头或函数 |
| 切换动作 | 改站点域名 CNAME，TTL 300 | 同左 | 同左 |

`features.comimi_reader` 默认关闭；开启后只在阅读设置中提供“增强分页”选项，由用户手动启用。
增强分页使用 Comimi 浏览器模块，三平台运行同一份静态产物，不增加函数、响应头或重定向规则，
也不改变平台配置生成物。模块加载或初始化失败时回退现有阅读器，保留当前页。
Comimi 原生仅支持单页与双页；条漫、文字层和 bbox 高亮继续由现有阅读器承担。
页码桥接保留现有 `#p<n>` 链接、章节进度和首页继续阅读；`#p<n>b<i>` 台词深链仍交给现有阅读器。
模块随站点打包为同源按需加载的脚本，不依赖外部脚本 CDN；未缓存时离线无法首次加载，
此时沿用原阅读器。图片仍按既有方式加载，这项功能不提供整站离线阅读。

仓库默认提供空内容模板与示例域名；三平台均需自行配置目标，生产发布拒绝示例站点及图片域名。
发布按钮通过 `publish_secrets_url`、`deploy_secrets_url` 引用维护者自己的密钥文件；
前者为上传必填，后者在选择部署目标时必填。检查与归档不再依赖外部邮件密钥。
密钥变量：`R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID`
`R2_SECRET_ACCESS_KEY` `R2_BUCKET` `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ACCOUNT_ID` `EDGEONE_API_TOKEN`
`EDGEONE_PROJECT_ID`（**项目 ID**，形如 `makers-…`，是权威定位）、`EDGEONE_PROJECT_NAME`（只作 CLI 的
`-n` 参数）、`EDGEONE_API_REGION`（token 签发区域：`china` | `global`）。EdgeOne 允许多个同名项目，
所以 `deploy:edgeone` 先用 Pages API 按 ID 核对名字、按名字核对同名唯一性，不一致就拒绝部署；可选
`EDGEONE_SECRET_ID` `EDGEONE_SECRET_KEY` `EDGEONE_ZONE_ID`（云 API 密钥对 + 站点 ID，
只给 `purge` 用，与 Makers 的 token 不是一回事）、`ESA_*`（清缓存，未实现）。
SEO 只走 IndexNow：key 按协议公开在 `site.config.yaml` 的 `seo.indexnow_key`，不是凭据，
不需要密钥文件；百度链路已废弃。CDN 的回源凭据是一对**只读**的
R2 API token，与 CI 的写凭据分开签发，泄露时各自轮换。

代码分层：`packages/core`（schema、解析器、归一化、DB 构建）、`packages/site`
（Astro）、`packages/search`（浏览器端检索）、`packages/platform`（配置 schema 与配置生成器）。
涉及文件系统与部署命令的编排在 `scripts/`。业务代码不 import 平台 SDK；可选函数检索
与对应平台入口壳尚未实现，`features.search_function` 目前只是预留配置。

**决策记录（2026-10-26）：站点初始化。** `npm run init` 在 `scripts/` 层编辑已有
`site.config.yaml`，复用平台层的完整配置校验，保留注释与未选择的字段。交互默认中文，
可切换英文；参数模式默认预览，显式 `--write` 才保存。写入前备份原文件，通过同目录
临时文件原子替换，检测到并发修改则中止。初始化只更新 YAML，派生配置和站点产物仍由
后续完整构建生成。

三平台共用这套初始化语义，配置 schema、部署适配器和发布流程保持不变。`--target`
只选择配置提示，不保存默认发布目标；Cloudflare 项目名使用现有字段，其他平台标识与
凭据继续由 secrets 提供。初始化既不联网验证云资源，也不创建资源或部署。示例域名可
用于预览，生产发布继续执行已有域名校验。工具的 `--ui-lang` 与站点 HTML 的
`--site-lang` 分开，后者不提供界面翻译；预留的函数检索开关不作为初始化选项暴露。

## 4. 数据模型

- **图片 key**：`img/<series>/<issue>/<chapter>/<n>-<sha256 前 12 位>.webp`（只用 webp：
  avif 编码慢、体积并不更小）。作品封面是 `img/<series>/cover-<hash>.webp`，与页图一起进
  manifest 的 `imageKeys`。内容哈希 = 不可变；R2 对象元数据 `Cache-Control: public,
  max-age=31536000, immutable`。修图 = 新 key + 重建引用页，不依赖清缓存。
- **`data/meta/<series>.yaml`**：作品（`title`、`sort`，可选 `description`、`authors`、
  `artists`、`status`、`year`、`tags`、`altTitles`、`cover`）、期（`number`、`title`、
  `published`）、话（`number`、`title`）、页（`n`、`img`、`w`、`h`），人工维护。
- **`data/text/<series>/<issue>/<chapter>.json`**（每话一文件，控制文件数）：

  ```json
  { "chapter": "sample/vol03/c012",
    "pages": [{ "n": 1, "boxes": [
      { "i": 0, "x": 0.12, "y": 0.08, "w": 0.20, "h": 0.15, "t": "原台词", "tn": "归一化文本" } ] }] }
  ```

  坐标归一化到 0–1，与分辨率无关。`tn` = NFKC → 去空白、标点、符号、控制 / 格式 /
  私用 / 代理字符与变体选择符 → 再 NFKC → OpenCC 繁→简 → 小写；`t` 只用于展示。
  去符号放在 OpenCC 之前，是让两遍归一化看到相同的相邻关系（幂等，索引与查询才对得上）；
  **不去未分配码位**——各引擎 Unicode 版本不同，构建端与浏览器端要算出同一个 `tn`。
  已知限制：CJK 部首补充区（U+2E80–2EF3）会整字被去掉。查询串走同一个函数。
  `w`/`h` 允许为 0：LabelPlus 的标签是一个点，不是框，阅读器对 0 尺寸的框画点标记。
- **LabelPlus 解析**：`>>>>>>>>[文件名]<<<<<<<<` 分块，
  `----------------[n]----------------[x,y,类型]` 为标签，随后到下一分隔符为文本；
  坐标已是 0–1 比例。页码：文件名第一段数字 = meta 的 `n`；任一文件名无数字则整份稿
  按文件出现顺序 1..N（逐文件混用会让 `cover.jpg` 与 `001.jpg` 静默并到同一页）。
  像分隔符但不完全匹配的行不改变解析结果，但作为提示报出来——真实导出若有固定偏差，
  只改解析器顶部的两条正则。这是首选文本来源；无稿时可用 Tesseract 生成 OCR 草稿，
  人工校对后再导入同一 schema，不能直接把机器识别结果当成正式台词。
- **`gallery.sqlite`**：

  ```sql
  CREATE TABLE series  (id TEXT PRIMARY KEY, title TEXT, sort INTEGER);
  CREATE TABLE issues  (id TEXT PRIMARY KEY, series_id TEXT, number REAL, title TEXT, published TEXT);
  CREATE TABLE chapters(id TEXT PRIMARY KEY, issue_id TEXT, number REAL, title TEXT, url TEXT);
  CREATE TABLE pages   (id INTEGER PRIMARY KEY, chapter_id TEXT, n INTEGER, img TEXT, w INTEGER, h INTEGER);
  CREATE TABLE lines   (id INTEGER PRIMARY KEY, page_id INTEGER, ord INTEGER,
                        x REAL, y REAL, w REAL, h REAL, text TEXT, text_norm TEXT);
  CREATE VIRTUAL TABLE lines_fts USING fts5(text_norm, content='lines', content_rowid='id', tokenize='trigram');
  -- 首条语句 PRAGMA page_size=4096（建表之后再设不生效）；末尾 journal_mode=DELETE; VACUUM;
  ```

  `page_size` 必须等于检索端 `requestChunkSize`。查询 ≥ 3 字走 `MATCH`；恰好
  2 字走 `LIKE`（全表扫描，可按作品过滤）；1 字拒绝。结果带 bbox，阅读器据此
  高亮气泡。对象存储上用带版本的 key `db/gallery-<version>.sqlite`（`version` 缺省是
  `<UTC 日期>.<运行序号>`，同一版本号只允许相同内容重试），`db/manifest.json` 指向已启用版本
  （`db: { version, key, size, sha256, pageSize, chunkSize, chunks }`，形状见
  `scripts/lib/manifest.mjs` 的 typedef），切换零缓存问题；DB 不进 dist、不进 Blob，
  所以没有 25 MB 托管上限。构建期对导出字节跑一次 `PRAGMA quick_check`，当前浏览器端校验整库
  sha256，并在下载前和流读取中执行大小上限。每个站点在构建时绑定自己的 `db`，不随共享指针变化。
  manifest 的 `sourceSha256` 覆盖元数据和完整台词内容；单独重建页面遇到陈旧库时要求重新完整构建。

## 5. 构建与发布

**决策记录（2026-10-26）：导入预览与文件冲突。** LabelPlus 导入的 `--dry-run` 与正式
导入共用解析、章节筛选、页码策略和逐章校验，返回新增 / 更新计划及未变章节，不执行目录
创建或写入；存在错误时仍汇总有效计划，并以非零退出。正式导入继续逐章写入有效结果，
不承诺整批事务。同章多个 `.txt` 大小写变体全部列为冲突，不再静默覆盖选稿，指定冲突章
也不误报缺稿。`data/meta` 与 `data/text` 的扩展名强制小写，避免内容在不同文件系统上
被静默忽略；这些检查由共享数据入口执行，适用于导入与构建。

所有流程 = `package.json` scripts，CI 文件只是壳，任何 CI 都能跑：

```
ingest:labelplus   data/raw/labelplus/<series>/<issue>/<chapter>.txt → data/text（CHAPTERS 限定；
                   CHAPTERS 里没稿但 meta 有的话只提示不报错，给 ocr 留路；LABELPLUS_PAGES 选页码策略）
ingest:ocr         显式 CHAPTERS → 缺稿话 OCR → out/ocr-review（JSON、页图与校对 HTML）
                   人工校对后放入 data/raw/ocr，再用 --accept-reviewed 校验导入 data/text
build:manifest     data/meta → out/manifest.json；有存储凭据时核对图片清单（缺 key 全列在
                   out/missing-images.txt）。发布流水线里凭据只给 verify:manifest 那一步
build:db           → gallery.sqlite
build:site         astro build（每话一 HTML，文字层内嵌）
build:index        元数据索引 JSON，按作品分片
build:sitemap      data/meta → dist/sitemap.xml（> 45 000 条时拆成 sitemap index + sitemap-<n>.xml）、
                   robots.txt；seo.indexnow_key 非空时另写 dist/<key>.txt（IndexNow 协议要求）
build:config       site.config.yaml → _headers / _redirects / edgeone.json
check              文件数、单文件、dist 无图片/DB、page_size、配置生成物同步、core 无 node: 导入、
                   sitemap 覆盖每一话（分片 ≤ 50 000 条）、IndexNow key 文件与配置一致
release:check      检查目标、环境与正式域名，拒绝 GitHub Pages 的 preview
release:prepare    生产部署前保存当前指针原文、ETag 与发布身份；清理旧部署记录
publish:r2         上传 gallery-<v>.sqlite(+chunks.json) / archive/site-<v>.tar.zst / 新图片
                   → 逐 key 核对 → db/manifest-<v>.json；不可变 key 不得覆盖不同内容
deploy:cloudflare  deploy:edgeone  deploy:github（DEPLOY_ENV=production|preview）
                   核对 dist/release.json 与清单身份及构建环境，成功后保存本目标的部署记录
release:activate   所选生产目标全部成功，且版本化清单一致后，用条件写入启用 db/manifest.json
purge              可选救火：EdgeOne CreatePurgeTask（任一目标被拒即失败）；ESA 未实现
push:search        部署之后（发布流水线写 STATUS 的那一步之后）主动把本次新增的页面推给搜索引擎：
                   IndexNow（seo.indexnow_key，Bing / Yandex / Naver / Seznam 共用）；不走百度。
                   Google 没有普通页面的推送接口，靠 robots.txt 的 Sitemap 声明。
                   新页面 = 新 manifest 与 out/manifest-previous.json 的 URL 差集；--all 推全部
status             写 STATUS.md（只由发布流水线调用）
```

搜索引擎推送的约定：只推差集不全推（引擎按频率与配额判滥发，上万话的站每次全推很快被拒）；
推之前先 GET 线上的 `/<key>.txt` 核对（隔 20 秒最多试 6 次，给 CDN 铺开留时间），不对就一条
都不推——它兼作「站点已上线」的探针；推送失败在流水线里 `allowFailure`，单独标红、
不判已完成的部署失败；页面集合与 sitemap 出自同一份 `scripts/lib/sitemap.mjs`。

版本号、上传顺序、缓存头的约定：带版本号的 key（库、分块摘要、归档、版本清单）一年 immutable，
`db/manifest.json` 只缓存 5 分钟；`chunks.json` 也按 `application/octet-stream` 上传，
免得 CDN 智能压缩把 Range 语义搞坏（§7）；归档格式固定 tar.zst，工具缺失就失败不换 gzip。
归档固定排序、时间、所有者和权限，重复构建同一内容能复用。创建不可变对象使用条件写入；
冲突后核对已存在内容，版本清单只忽略生成时间。启用生产指针时匹配准备阶段的 ETag，
并发更新会被拒绝；同次启用响应丢失可安全重试。部署步骤核对的是清单身份，正常流水线须
连续使用同一份 dist；它不是对目录任意后续修改的逐文件签名。

`.cnb.yml`：main 的 `push` 触发检查，手动按钮触发发布与归档（按钮在
`.cnb/web_trigger.yml`）。检查步骤：提交信息（本次推送区间）→ check → test → build →
再 check → 用测试样本全量空跑 → 分层提示 → 移动 `last-green`。发布输入 `chapters`、`target`
（none | cloudflare | edgeone | github | all）、`ocr`、`deploy_env`（production | preview）、
`version`（留空 = 日期.构建号）、`push_all`；步骤：参数检查 → ingest → build → check → verify:manifest →
release:prepare → publish:r2 → deploy → release:activate → 写 `STATUS.md` → push:search →
连同 ingest 写回的 `data/text` 提交。预览与 `target=none` 在上传或部署后结束，不启用生产指针、
不改生产状态、不推送搜索引擎。预览 HTML 带 `noindex`；GitHub Pages 没有独立预览环境，
`preview + github/all` 在上传前拒绝。多平台部署失败时已完成的目标可能已更新，但各自页面
绑定自己的检索库，生产指针保持原值；启用之后的状态记录失败不会撤回已上线页面。
OCR 草稿通过提交附件保留，可在浏览器下载校对；发布不会自动导入草稿。默认模板不附带作品
与台词稿，OCR 功能本身不代表已完成内容识别或校对。
凭据经独立密钥仓库的 `imports` 注入，只有需要的步骤才拿得到；发布与归档只能手动触发，
`crontab:` 被 `npm run check` 解析 `.cnb.yml` 拦住。

为什么构建在 CNB 而不是平台构建机：构建机与应用托管解耦，产物能同时发往三个目标并归档到 R2；
平台构建机只会把 dist 留在那一家。Makers 构建机（500 次/月、20 分钟、无 Python）留作纯静态构建的
备用，OCR 不放那里。`scripts/` 仍是流水线的全部内容，`.cnb.yml` 只是壳——任何 CI 都能跑同一条流水线。

## 6. 检索

- **已实现代码路径**：浏览器端 sqlite-wasm 经 CDN 整库下载，校验长度、上限和 sha256 后查询。
  页面绑定构建版本；查询归一化后不足两字、或本版台词覆盖率为零时，不发起数据库下载。
  空目录和已有作品但无台词稿分别显示提示。
  三字及以上走 trigram，两字走 LIKE，按作品过滤；每批 50 条，可继续加载。
  没有构建绑定的独立调用方仍可读取 manifest，逐源验证清单并在坏源时切换。
- **后续接入路径**：现有取块层尚未接到 SQLite VFS；函数加速也未接通。
  接入后按 Range 分块读取，减少首次下载量。
- **取块层的已有能力与后续接线约定。** 取块层照搬翻译组多源分块下载框架
  （anabranch）的模型，因为它在 CDN 上踩过的坑就是我们要踩的：
  - 探测：先 HEAD，`Accept-Ranges: bytes` + `Content-Length` 才算；否则
    `GET Range: bytes=0-0`，**只有 206 + `Content-Range` 才算真支持**，200 就是
    服务端无视了 Range。总长从 `Content-Range` 的 `/total` 取。
  - 取块：请求 `bytes=a-b` 却收到 200 且 a>0 → 拒绝（照收就是把文件开头塞进
    中间，静默损坏）；实收字节数 ≠ 请求长度 → 该块失败，不许标成完成。
  - 校验：`build:db` 顺手产出 `gallery-<date>.sqlite.chunks.json`——按 64 KB
    （page_size 的 16 倍）逐块 sha256 + 整份 sha256，与 DB 同版本、同域名。取块层
    只按 64 KB 对齐取，块校验通过才进页缓存交给 sqlite。CDN 回错字节、缓存串台、
    截断，全在这一层被抓住而不是变成 `database disk image is malformed`。
  - 多源：图片域名可以有两个（EdgeOne / ESA 各一），取块层按实测吞吐 EMA ÷ (1 +
    在途数) 选源，块失败先原地退避重试、连错三次换源；一条 CDN 挂了不影响检索。
    **跨源不比 ETag**——同一份字节在两家 CDN 上 ETag 几乎必然不同，只比长度，
    正确性由逐块摘要兜底。
  - 卡住的源用时间预算而不是次数兜：接了连接不回数据的那种，次数上限只会把
    读超时乘上去。探测本身也带固定时限，超时的源在探测阶段就禁用。
  - 几条实现上的细则：HEAD 回 `Content-Length: 0` 不算数（一些代理的已知毛病），落到
    GET 探测；无视 Range、`Content-Range` 不符、摘要不符这三类「源在撒谎」立刻换源，
    其余（超时、网络、4xx/5xx、短读）原地退避、连错三次才换，且换源也看该源的全局连败数；
    取块时才暴露「所有源都无视 Range」同样报 `needs-whole` 退化到整份下载；每块的重试
    次数上限按源数推导（≥ 源数 × 3），保证第三条源轮得到。
  - 后续接线的退化方案：探测结论是不支持 Range，或总长 ≤ 30 MB 且用户网络快——整份
    下载、验整份 sha256、载入内存。函数版检索仍是规划；当前整库下载失败时提示
    “检索暂不可用”，页面照常。
- 取块层与 sqlite 无关，是 `packages/core` 里的纯 Web 标准模块（fetch + Web
  Crypto）。阅读器图片由内联错误处理切换备用域名，不使用取块层或 HEAD 探测。
- **可选加速（规划）**：配置保留 `features.search_function` 与 `/api/search`，但函数入口
  与前端探测尚未接通；当前检索始终在浏览器中执行。
- **元数据检索**（期数、标题、话数）：纯前端过滤索引 JSON：`/index/series.json`
  （作品总表：id、title、url、期数、话数）与 `/index/<series>.json`（该作品的期与话：
  number、title、published、url、key、页数、hasText），按作品分片。
- 不用 Pagefind：按词索引，跨词边界子串搜不到，台词场景会漏。
- 不用 Makers Blob 放 DB：只有 Node SDK、每次读都要过函数、免费 1 GB，
  且文档明确不建议当公网读取入口；DB 经 CDN 读 R2 在三平台上行为一致。

## 7. CDN 与缓存

- **R2 私有读**，CDN 以 S3 私有回源（SigV4）取源；EdgeOne 的对象存储源站支持此
  模式，ESA 侧的私有回源鉴权在接入时验证并记到决策记录。浏览器、站点、任何
  平台都不持有 R2 凭据。
- **CORS 与 Range 在 CDN 规则层解决**，不依赖 R2 桶的 CORS 配置（私有回源时
  Origin 头不一定透传）：`Access-Control-Allow-Origin` = 站点域名 + 三平台的
  预览域名（`*.pages.dev`、`*.edgeone.site`、`*.github.io`）；允许 GET/HEAD/OPTIONS，
  `Allow-Headers` 含 `Range`（单区间 Range 是 CORS 安全头、不触发预检，仍放行
  OPTIONS 以防某家 CDN 的实现不认）；暴露 `Content-Range` `Content-Length` `ETag`
  `Accept-Ranges` `Content-Encoding`（最后一个纯为诊断：取块层发现长度不符时能在报错里
  指出是压缩造成的）；开启 Range 回源与分片缓存。
- **`db/*` 路径关闭 CDN 智能压缩**，`Content-Type: application/octet-stream`。带
  `Content-Encoding` 的响应 `Content-Length` 是压缩后长度，Range 语义整个变味；
  浏览器又改不了 `Accept-Encoding`，只能从 CDN 侧掐掉。
- 图片域名：节点缓存 30 天 + 离线缓存（源站故障时继续服务已缓存对象）；浏览器侧
  靠 immutable 哈希 key 缓存一年；关闭查询串透传；图片只有 webp 一种格式（`<img>`，
  **不用 `Vary: Accept`**）。
- 防盗链放 CDN 层（Referer / 速率限制），不在 R2 层做。
- HTML / 索引 JSON / sitemap 走托管平台默认策略（无哈希文件不缓存或短缓存，
  新部署自动失效），不要套图片域名的 30 天规则。
- 清 CDN 缓存清不掉用户浏览器缓存，所以修图只走「新 key + 重建」；`purge` 只用于
  救火。

## 8. 生存性

账号级依赖与各自的失效模式：

| 依赖 | 死法 | 对策 |
|---|---|---|
| 域名 | 到期 | 一次续到注册商上限，不依赖自动续费的卡 |
| R2 | 卡失效欠费 → 整个账号被停 | 用量压在免费额度内（10 GB、每月 1000 万次 Class B）；归档包在别处也有 |
| CDN 账号（EdgeOne / ESA） | 免费套餐停用或改规则 | 双 CDN 互为备份；README 里写明「把 img 域名切到任何支持 S3 私有回源的 CDN」的步骤 |
| 托管平台 | 配额调整、产品下线 | 三平台可移植，dist 归档在 R2 |
| 函数运行时 | Node 版本下线 | 检索默认浏览器端，函数永远可选 |

- 仓库公开，`README.md` 的「怎么跑」给出构建与发布入口：fork → 填密钥仓库 → 点「发布」→
  改 CNAME。任何人不联系原维护者也能复活站点。
- 每次发布的 `site-<date>.tar.zst` 与 `gallery-<date>.sqlite` 留在 R2；每卷图片
  另打归档包并公开链接，便于社群做镜像 / 做种 / 推 Internet Archive。
  **站点可以死，数据不能只存在一个账号里。**
- 免费层配额会变（Makers 文档明确说商业化后调整），不为任何平台做深度优化。

## 9. 已知坑

- Makers Blob：单对象 25 MB、免费 1 GB、只有 Node SDK、不建议当公网读取入口。
- Makers Edge Functions 5 MB 包 + 300 万 ms CPU/月：塞不下也跑不起检索。
- Makers KV 需要审批，单值 1 MB——不用。
- Makers 与 Cloudflare Pages 同为 20 000 文件上限：每页一 HTML 会很快撞线。
- GitHub Pages 无响应头：CORS / 缓存 / 安全头全部只能在 CDN 侧解决。
- trigram `MATCH` 少于 3 字无结果；繁简混输靠 `text_norm` 归一。
- （GitHub Actions 时期）自托管 runner 计入配额（公开库除外）：不要在 Droidspaces
  里挂 self-hosted runner 省额度；迁到 CNB 后不再适用。
- 平台的定时任务（GitHub Actions 的 cron、CNB 的 crontab）在仓库长期无活动后会停用，
  所以定时触发被铁律禁止。
- Pagefind 1.5 虽已自动分词 CJK，但仍是按词匹配，台词检索不够用。

## 10. 落地顺序

每步以 `npm run check` 通过为完成：

1. 仓库骨架与空跑：`packages/{core,site,search,platform}`、`data/{meta,text}`、
   `scripts/`、`site.config.yaml`、全部 scripts 占位、`.cnb.yml` /
   `.cnb/web_trigger.yml`、`README.md`、`STATUS.md`。
2. `core`：schema（zod）、LabelPlus 解析器 + 测试样本、`tn` 归一化、分块摘要清单；
   发布 manifest 的编排在 `scripts/lib/manifest.mjs`。
3. `site`：Astro，作品 / 期 / 话页面 + 阅读器（绝对定位透明 span 文字层，
   `#p12` 深链），sitemap，索引分片。
4. `build:db` + 浏览器端检索页：整份下载 + sha256 校验 + sqlite-wasm（FTS5 trigram）查询
   已落地，取块层也已实现；SQLite VFS 接线与函数版加速仍待做，在 CDN 私有回源 + CORS 下
   验证可用后把结果记入决策记录。
5. `platform`：`build:config` 生成器、三套 deploy 脚本、Hono 函数壳（可选）。
6. `publish:r2`、`check`、`STATUS.md` 自动更新；跑通 `target=all` 一次。
7. 端到端验证：三平台各部署一次，切 CNAME 各验一次；记录耗时到 STATUS.md。

## 决策记录

- 2026-09-03 初版。R2 保持私有读，读取一律经 CDN（回源鉴权在 CDN 侧），
  CORS/Range 在 CDN 规则层配置。Blob/KV/D1 不作为必需依赖。构建放 GitHub
  Actions（公开仓库），平台构建机仅备用。检索默认浏览器端 httpvfs。
- 2026-09-03 检索取块层采用 anabranch 的探测 / 取块 / 校验 / 多源模型（§6）。
  由此"双 CDN 的 Range 行为"不再是待验证项而是被设计兜住的项：任何一家 CDN 无视
  Range、回错字节或截断，都会被探测与逐块校验抓住并切源或退化，不会静默损坏。
- 待验证：ESA 对 S3 私有回源的 SigV4 支持；两家 CDN 对 `db/*` 的分片缓存是否
  真按 Range 回源（不是每次拉整份）——这只影响回源次数，不影响正确性。
- 2026-09-03 骨架落地（§10 第 1 步）。约定几处文档没写死的形状：URL 结构为
  `/<series>/`、`/<series>/<issue>/`、`/<series>/<issue>/<chapter>/`（每话一目录一 `index.html`，
  阅读器内翻页）；§4 图片 key 里的 `<chapter>` 指「期/话」两段，即
  `img/<series>/<issue>/<chapter>/<n>-<hash12>.webp`，与 `data/text` 的 `chapter` 字段同形。
  平台配置生成物入库在 `packages/platform/generated/`，`check` 逐字节比对；站点读的
  `site-config.json` 不入库，构建时重生成。产物目录：`dist/` 只放静态站，`out/` 放
  manifest、DB 与归档。`edgeone.json` 按 EdgeOne Pages 文档的 `headers[{source,headers[{key,value}]}]`
  / `redirects[{source,destination,statusCode}]` 形状生成——**首次真实部署时验证**，不对再改生成器。
- 2026-09-03 sqlite 的 wasm 实现定为官方 `@sqlite.org/sqlite-wasm`：实测 sql.js 1.14 的
  官方发行版**没有编入 FTS5**（`no such module: fts5`），trigram 台词库建不出来；
  官方 wasm 3.53 在 Node 与浏览器里都能跑，FTS5 trigram、`PRAGMA page_size` 与
  `sqlite3_js_db_export` 均已验证。铁律 1 的措辞随之从「一律 sql.js」改为「一律 wasm 版」，
  约束的实质（不引原生绑定）不变。浏览器端 VFS 的选择（官方 wasm 自定义 VFS，或
  sql.js-httpvfs 自带的含 FTS5 构建）留给检索落地时按可行性定。
- 2026-09-03 §10 第 2–5 步一次落地（core 解析与归一化、检索库构建、取块层、站点、发布脚本），
  每块各经一轮对抗式审查与修复。几处文档没写死、由实现定下的形状：
  - 站点数据通道：`build:site` 先把模型写成 `packages/site/src/generated/gallery.json`（结构，不含
    台词）与 `text/<series>/<issue>/<chapter>.json`（每话台词），页面只 import JSON / `import.meta.glob`。
    `gallery.json` 标 `hasText` 的话在 `text/` 下缺分片 = 构建错误（阅读器页抛错，不静默退化）。
  - 阅读器 hash：`#p<n>` 定位到第 n 页；`#p<n>b<i>` 再高亮第 i 个框（检索结果按此链过来）；
    无 JS 时全部页纵向可见、靠 `:target` 高亮。阅读器脚本内联（每份 HTML 多 ~4 KB）换取不闪；
    样式用全局样式加 `.reader` 前缀，避免作用域样式给每个台词框加属性。
  - 作品 id 保留字：`search` `api` `index` `series` `404` `cname`（撞上站点固定路由或基线文件，
    Astro 只会静默让静态路由赢），`build:site` / `build:index` 直接报错。
  - sitemap 的 `<lastmod>` 取期的 `published`；`robots.txt` 由构建生成（含域名）。
  - 版本号：缺省 `<UTC 日期>.<运行序号>`，同一版本号只发布一次（版本化 key 一年 immutable）。
  - EdgeOne CLI：`edgeone makers deploy <dist> -n <项目名> -e <env>`，token 走 `EDGEONE_PAGES_API_TOKEN`
    环境变量而非 argv（进程参数对同机进程可见）；`-a` 取值待首次部署验证。Cloudflare：
    `wrangler pages deploy --branch main`，Pages 项目的 production branch 必须是 main，否则静默落到
    preview（CLI 照样退 0，只能从 URL 看出来）。
  - OpenCC 用 `from: 't'`（OpenCC 标准繁体）。`tw`/`hk` 同样在 t2cn 子路径里、不增体积，但会把
    单独的「么」折成「幺」；「著/着」「裡/裏」的取舍等看过真实稿再定（改 normalize.js 一行）。
  - sha256 只有一份实现（`db/chunks.js`），取块层转发它：构建端算、浏览器端验，算法必须逐字节一致。
- 首次真实部署时必须由人验证（CI 替代不了，CONTRIBUTING §二.3 第三级）：
  1. EdgeOne：`EDGEONE_PROJECT_ID` 填项目 ID（makers-…）、`EDGEONE_PROJECT_NAME` 填项目名、
     `EDGEONE_API_REGION` 与 token 签发区域一致；先 preview 核对 CLI 输出的项目名与 URL；
     项目须是「直接上传」类型；给已 build 的目录时 CLI 是否只上传不再自行 build；dist 里的
     `edgeone.json` 是否被识别（不识别则把 `deploy.mjs` 的 cwd 改为 dist 再试）；`-a` 取值。
  2. Cloudflare：Pages 项目已建（direct upload）、production branch 为 main、token 有 Pages 编辑权限。
  3. 对象存储：PUT 的 `Content-Type` / `Cache-Control` 落成对象元数据且经 CDN 读到（尤其
     `chunks.json` 为 octet-stream、`db/*` 不被智能压缩）；S3 客户端的 `forcePathStyle` 与
     `WHEN_REQUIRED` 校验和设置对真实存储有效。
  4. purge：`CreatePurgeTask` 对默认目标（`db/manifest.json` 的 CDN 地址）是否接受 `purge_url`；
     不接受则用 `--prefix`。
  5. 取块层默认 `timeoutMs=15000` / `budgetMs=60000` 在真实 CDN 上是否合适；两家 CDN 对 HEAD 的
     实际行为（是否放行、是否带 `Accept-Ranges`、`Content-Length` 是否为 0）。
  6. 用翻译组一份真实的 LabelPlus 导出跑一次 `ingest:labelplus`，核对分隔符形状与坐标小数位。
  7. 首次 `push:search`：IndexNow 回 403 说明引擎取不到 `/<key>.txt`（托管平台对 .txt 的
     Content-Type 或缓存）、422 说明 urlList 的 host 与 `host` 不一致（www 与裸域名）；
     首次全站推送可能超当日配额、超出部分下次再推。
- 2026-09-03 sitemap 与搜索引擎推送。拆分线 45 000（协议 50 000）留余量，index 的 `<lastmod>` 是生成日；
  `sitemap.xml` 永远是入口（单文件或 index），分片 `sitemap-<n>.xml`，robots 与外部登记只指入口。
  IndexNow 的 key 进 `site.config.yaml` 而不是 secrets：协议要求它公开放在站点根，不是凭据。
  推送脚本不做已下线页面的通知（IndexNow 支持推已删除 URL 让引擎重抓，将来需要再加）。
- 2026-10-20 流水线迁到 CNB 云原生构建。`.cnb.yml` 承载三条流水线：main 的 `push` 跑检查并
  移动 `last-green`、`web_trigger_release` 手动发布、`web_trigger_archive` 手动归档；
  `.cnb/web_trigger.yml` 放 main 分支详情页的按钮。`.github/workflows` 删除，避免两份真相；
  `npm run check` 改为解析 `.cnb.yml`，守「只有 main 的 push 跑检查、发布只手动、无 `crontab:`」。
  凭据从平台 secrets 改为独立密钥仓库的 `imports`（铁律 7 不变）；GitHub Pages 目标改由流水线把
  dist 推到 `gh-pages` 分支，需要 `GITHUB_PAGES_REPO` / `GITHUB_PAGES_TOKEN`。CNB 没有「在失败
  提交下留言」的接口，红灯以构建状态为准（pre-push 闸门仍查 CNB 构建状态）。
  首次真实发布时要验证：密钥仓库引用权限、`git push` last-green 与回写 main 的令牌权限、
  CNB 仓库是否强制提交签名（CI 提交未签名；强制的话需要给构建令牌登记签名密钥或对 CI 提交放宽）。
- 2026-10-20 EdgeOne 项目定位改为「ID 权威 + 名字部署 + 部署前校验」。CLI 的 `makers deploy -n`
  只按名字解析（源码里按 Name 过滤取第一个；EdgeOne 允许多个同名项目），没有按 ID 部署的参数。
  因此 `EDGEONE_PROJECT_ID` 填项目 ID，新增 `EDGEONE_PROJECT_NAME`（仅作 `-n`）与 `EDGEONE_API_REGION`
  （token 签发区域，决定 Pages API 端点）；`deploy:edgeone` 先用 DescribePagesProjects 按 ID 核对
  名字、按名字核对同名唯一性，不一致就拒绝部署（一个字节都不传）。项目与区域由维护者配置。
- 2026-10-20 SEO 只走 IndexNow，移除百度链接提交。百度要站点级 token、长期不推会被降权，
  且与 IndexNow 的公开 key 验证是两套模型。`push:search` 去掉百度分支与 `BAIDU_PUSH_TOKEN`，
  密钥仓库不再需要 `seo.yml`（IndexNow key 按协议公开在 `site.config.yaml`，不是凭据）。
- 2026-10-20 浏览器端检索执行器落地（整份下载路径）。`packages/search` 实现 `queryLines` /
  `loadGalleryDb` / `mountSearch`：搜索页懒加载 `db/manifest.json` → 整份下载检索库 → 按 manifest
  的 size / sha256 校验 → `openGalleryDb`（sqlite-wasm，FTS5 trigram）→ ≥ 3 字 MATCH、恰好 2 字
  LIKE、1 字拒绝，结果链到 `#p<n>b<i>`。这是 §6 的退化路径；按 Range 分块（自定义同步 VFS）
  与函数版加速尚未实现，接口不变。搜索页提示、README 与 §10 落地顺序同步更新。
- 2026-10-21 发布改为不可变上传、部署确认、条件启用三阶段，预览和仅上传不改生产指针。
  搜索页绑定构建库版本，先校验查询与台词覆盖率，再进行有上限的下载；增加作品过滤和分页。
  阅读器修复 RTL 翻页、双页布局和长条进度恢复，并补充行为测试。
  OCR 从占位入口改为可选草稿生成与显式校对导入，现有台词覆盖仍需人工补齐。
- 2026-10-24 增加默认关闭的 `features.comimi_reader`，允许用户选择浏览器端增强分页。
  保留原阅读器作为条漫、文字层、台词深链与加载失败的回退路径；旧页码和进度格式不迁移。
  增强模块随静态产物同源加载，三平台适配逻辑与配置生成物不变。
- 2026-10-24 站点改为通用模板：移除预置实际作品，配置使用示例域名，发布密钥来源显式输入。
  空站提供明确提示，继续阅读仅显示当前目录仍存在的章节；发布状态在首次真实发布前保持未发布。
- 2026-10-25 阅读可靠性与目录规模化：阅读页仅保留常量数量的静态目录入口，完整章节列表在首次
  打开侧栏时读取已有作品索引，支持筛选、当前章定位、失败重试与本页成功缓存；不增加平台配置。
  图片状态提示放在框外，自动切换配置来源并支持逐页重试，保留台词层、懒加载和阅读进度。
  首页与作品页继续阅读精确匹配现有章节并约束旧页码；“最近更新”改称“各作品最新一话”，
  在没有章节发布时间字段时不暗示时间排序。对应行为与构建产物纳入测试。
- 2026-10-25 构建环境明确要求 Node >=22.19.0、npm >=9.6.5，并更新锁定的构建工具依赖。
  运行时依赖约束和纯静态部署形态不变。
- 2026-10-25 长条阅读按页顶的纵向顺序二分定位当前页，将每个滚动帧的布局读取从线性扫描降为
  对数次数；每次使用实时位置，不缓存可能随图片加载或视口变化失效的坐标。保留气泡可见时的
  命中页、恢复阶段保护、文末归最后一页和仅跨页保存进度的规则。1000 页 DOM 夹具中，第 900 页
  及同页继续滚动的页位置读取由各 900 次降至最多 10 次；这衡量算法读取成本，不代表实体设备帧率。
