# ARCHITECTURE.md — 技术档案与决策

> 本文件记录**是什么、为什么**。规范（必须怎么做）在 `CLAUDE.md` / `AGENTS.md`，
> 改了这里的决策要同步改那边的规则，反之亦然。
> 每节末尾的「决策记录」按时间追加，不删旧条目。

## 0. 目标与约束

**公开的漫画画廊**：作品 / 期 / 话 / 页浏览；期数等元数据检索；台词
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
本地翻译产物 (LabelPlus txt / PSD 文字层 / OCR JSON)
        │  ingest（release.yml 里跑；OCR 仅在缺稿时）
        ▼
data/meta/*.yaml + data/text/<series>/<chapter>.json        ← 仓库（公开）
        │  build（GitHub Actions；Makers 构建机仅作纯静态构建备用）
        ▼
dist/            静态 HTML(每话一文件，内嵌文字层) + 元数据索引 JSON 分片 + sitemap.xml
gallery.sqlite   FTS5 trigram 台词库；manifest.json；dist 归档
        │
        ├─ dist ──────────→ Cloudflare Pages | EdgeOne Makers | GitHub Pages（三选一，CNAME 切换）
        └─ 图片/DB/归档 ──→ Cloudflare R2（私有桶，唯一持久数据源）
                               └─ 图片域名 img.<domain>：EdgeOne + ESA，CNAME 接入，
                                  以 S3 私有回源（SigV4）读 R2；所有读取都经这里
浏览器端检索：sql.js-httpvfs 用 HTTP Range 经 CDN 读 gallery.sqlite，零服务端
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

| | Cloudflare Pages | EdgeOne Makers | GitHub Pages |
|---|---|---|---|
| 部署 | `wrangler pages deploy dist` | `edgeone makers deploy`（上传 dist；`edgeone pages` 为兼容命令） | `actions/upload-pages-artifact` + `actions/deploy-pages` |
| 配置生成物 | `dist/_headers`、`dist/_redirects` | `edgeone.json`（headers ≤ 30，redirects/rewrites ≤ 100） | 无；`.nojekyll`、`CNAME`、`404.html`，重定向用 `<meta http-equiv="refresh">` |
| 函数入口 | `functions/`（Workers 运行时，`export default { fetch }`） | `edge-functions/`（isolate，`onRequest`）、`cloud-functions/`（真 Node） | 无 |
| 切换动作 | 改站点域名 CNAME，TTL 300 | 同左 | 同左 |

密钥（GitHub Secrets）：`R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY`
`R2_BUCKET` `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ACCOUNT_ID` `EDGEONE_API_TOKEN`
`EDGEONE_PROJECT_ID`；可选 `ESA_*`（清缓存）。CDN 的回源凭据是一对**只读**的
R2 API token，与 CI 的写凭据分开签发，泄露时各自轮换。

代码分层：`packages/core`（schema、解析器、归一化、DB 构建）、`packages/site`
（Astro）、`packages/search`（浏览器端检索 + 可选 Hono 函数）、`packages/platform`
（deploy 脚本、配置生成器、函数入口壳）。业务代码不 import 平台 SDK；Hono 的
入口壳分别是 Workers 的 `fetch(request, env)` 与 Makers 的 `onRequest({ request })`。

## 4. 数据模型

- **图片 key**：`img/<series>/<chapter>/<n>-<sha256 前 12 位>.avif`（另出同名
  `.webp`）。内容哈希 = 不可变；R2 对象元数据 `Cache-Control: public,
  max-age=31536000, immutable`。修图 = 新 key + 重建引用页，不依赖清缓存。
- **`data/meta/<series>.yaml`**：作品、期（`number`、`title`、`published`）、
  话（`number`、`title`）、页（`n`、`img`、`w`、`h`），人工维护。
- **`data/text/<series>/<chapter>.json`**（每话一文件，控制文件数）：

  ```json
  { "chapter": "sample/vol03/c012",
    "pages": [{ "n": 1, "boxes": [
      { "i": 0, "x": 0.12, "y": 0.08, "w": 0.20, "h": 0.15, "t": "原台词", "tn": "归一化文本" } ] }] }
  ```

  坐标归一化到 0–1，与分辨率无关。`tn` = OpenCC 繁→简 + `normalize('NFKC')` +
  去空白与标点；`t` 只用于展示。
- **LabelPlus 解析**：`>>>>>>>>[文件名]<<<<<<<<` 分块，
  `----------------[n]----------------[x,y,类型]` 为标签，随后到下一分隔符为文本；
  坐标已是 0–1 比例。这是首选文本来源；OCR（BallonsOCR / PaddleOCR 输出转同一
  schema）只补缺稿——自己汉化的成品没必要再 OCR 一遍。
- **`gallery.sqlite`**：

  ```sql
  CREATE TABLE series  (id TEXT PRIMARY KEY, title TEXT, sort INTEGER);
  CREATE TABLE issues  (id TEXT PRIMARY KEY, series_id TEXT, number REAL, title TEXT, published TEXT);
  CREATE TABLE chapters(id TEXT PRIMARY KEY, issue_id TEXT, number REAL, title TEXT, url TEXT);
  CREATE TABLE pages   (id INTEGER PRIMARY KEY, chapter_id TEXT, n INTEGER, img TEXT, w INTEGER, h INTEGER);
  CREATE TABLE lines   (id INTEGER PRIMARY KEY, page_id INTEGER, ord INTEGER,
                        x REAL, y REAL, w REAL, h REAL, text TEXT, text_norm TEXT);
  CREATE VIRTUAL TABLE lines_fts USING fts5(text_norm, content='lines', content_rowid='id', tokenize='trigram');
  -- 构建末尾：PRAGMA journal_mode=DELETE; PRAGMA page_size=4096; VACUUM;
  ```

  `page_size` 必须等于检索端 `requestChunkSize`。查询 ≥ 3 字走 `MATCH`；恰好
  2 字走 `LIKE`（全表扫描，先按作品/期过滤）；1 字拒绝。结果带 bbox，阅读器据此
  高亮气泡。R2 上用带版本的 key `db/gallery-<date>.sqlite`，manifest 指向当前版本，
  切换零缓存问题；DB 不进 dist、不进 Blob，所以没有 25 MB 上限。

## 5. 构建与发布

所有流程 = `package.json` scripts，CI 文件只是壳，任何 CI 都能跑：

```
ingest:labelplus   LabelPlus txt → data/text
ingest:ocr         缺稿卷 OCR → data/text（Python，只在 Actions 跑）
build:manifest     data/meta → manifest.json（校验 R2 图片清单）
build:db           → gallery.sqlite
build:site         astro build（每话一 HTML，文字层内嵌）
build:index        元数据索引 JSON，按作品分片
build:sitemap
build:config       site.config.yaml → _headers / _redirects / edgeone.json
check              文件数、单文件、dist 无图片/DB、page_size、配置生成物同步、core 无 node: 导入
publish:r2         上传 gallery-<date>.sqlite / manifest.json / site-<date>.tar.zst / 新图片
deploy:cloudflare  deploy:edgeone  deploy:github
purge              可选：EdgeOne CreatePurgeTask + ESA PurgeCaches
```

`release.yml`：`workflow_dispatch`，输入 `chapters`（逗号分隔）、`target`
（cloudflare | edgeone | github | all）、`ocr`（bool）。步骤：ingest → build →
check → publish:r2 → deploy → 写 `STATUS.md` 并提交。`checks.yml`：push 触发，
只跑 check / test / build dry-run 并移动 `last-green`。

为什么构建在 GitHub Actions 而不是平台构建机：仓库公开时标准 runner 免费无配额，
产物能同时发往三个目标并归档到 R2；平台构建机只会把 dist 留在那一家。Makers
构建机（500 次/月、20 分钟、无 Python）留作纯静态构建的备用，OCR 不放那里。

## 6. 检索

- **默认路径**：浏览器端 sqlite-wasm（`sql.js-httpvfs` 或官方
  `@sqlite.org/sqlite-wasm` 自定义 VFS），通过 `https://img.<domain>/db/gallery-<date>.sqlite`
  按 Range 分块读，一次查询只传几百 KB；无任何服务端。
- **不信任 CDN 的 Range，用取块层兜住。** 取块层照搬翻译组多源分块下载框架
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
    读超时乘上去。
  - 退化：探测结论是不支持 Range，或总长 ≤ 30 MB 且用户网络快——整份下载、验整份
    sha256、载入内存。再退一级才是函数版检索，最后是"检索暂不可用"，页面照常。
- 取块层与 sqlite 无关，是 `packages/core` 里的纯 Web 标准模块（fetch + Web
  Crypto），阅读器的图片加载共用它的多源与探测逻辑（图片不分块，只做域名切换）。
- **可选加速**：Hono 函数经 CDN 拉库进 sql.js 内存，只部署在 Cloudflare Workers
  或 Makers Cloud Functions；前端探测 `/api/search` 不可用时自动回退。
- **元数据检索**（期数、标题、话数）：纯前端过滤索引 JSON。
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
  `Accept-Ranges`；开启 Range 回源与分片缓存。
- **`db/*` 路径关闭 CDN 智能压缩**，`Content-Type: application/octet-stream`。带
  `Content-Encoding` 的响应 `Content-Length` 是压缩后长度，Range 语义整个变味；
  浏览器又改不了 `Accept-Encoding`，只能从 CDN 侧掐掉。
- 图片域名：节点缓存 30 天 + 离线缓存（源站故障时继续服务已缓存对象）；浏览器侧
  靠 immutable 哈希 key 缓存一年；关闭查询串透传；avif/webp 用不同文件名 +
  `<picture>`，**不用 `Vary: Accept`**（两套 CDN 的缓存 key 行为不一致）。
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

- 仓库公开，`README.md` 顶部是「十分钟重建」：fork → 填 secrets → 跑
  `release.yml` → 改 CNAME。任何人不联系原维护者也能复活站点。
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
- 2026-03 起自托管 runner 计入 Actions 配额（公开库除外）：不要在 Droidspaces
  里挂 self-hosted runner 省额度。
- Actions 的 cron 在仓库 60 天无活动后停用，所以 `schedule:` 被铁律禁止。
- Pagefind 1.5 虽已自动分词 CJK，但仍是按词匹配，台词检索不够用。

## 10. 落地顺序

每步以 `npm run check` 通过为完成：

1. 仓库骨架与空跑：`packages/{core,site,search,platform}`、`data/{meta,text}`、
   `scripts/`、`site.config.yaml`、全部 scripts 占位、`checks.yml` /
   `release.yml`、`README.md`（十分钟重建）、`STATUS.md`。
2. `core`：schema（zod）、LabelPlus 解析器 + 测试样本、`tn` 归一化、manifest 生成。
3. `site`：Astro，作品 / 期 / 话页面 + 阅读器（绝对定位透明 div 文字层，
   `#p12` 深链），sitemap，索引分片。
4. `build:db` + 浏览器端检索页（httpvfs）；在 CDN 私有回源 + Range + CORS 下
   验证可用，结果记入决策记录。
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
  `img/<series>/<issue>/<chapter>/<n>-<hash12>.avif`，与 `data/text` 的 `chapter` 字段同形。
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

