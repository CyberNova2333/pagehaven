# comics-gallery · 漫画画廊

> **静态漫画阅读与元数据导航，配套可复用的数据模型和分块读取组件。**

已实现作品 / 期 / 话 / 页浏览与站点地图生成。台词全文检索已有数据与分块读取基础，但浏览器检索执行器仍未实现，搜索页面目前是界面壳。
产物是纯静态文件，托管在 Cloudflare Pages / EdgeOne Makers / GitHub Pages 三者之一，
随时切换；图片与检索库在对象存储，经 CDN 读取。设计与决策见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。


**阅读导航**

[🏛️ 分层代码架构](#section-1) · [🚀 环境与使用入口](#section-2) · [📚 重建与手动发布](#section-3) · [🚀 怎么跑](#section-4) · [🏛️ 目录](#section-5) · [📚 参与开发](#section-6) · [📜 许可](#section-7)

---

<a id="section-1"></a>

## 🏛️ 分层代码架构

代码由 Astro 页面、可复用的纯逻辑包和 Node 工具组成。阅读页已有页面内交互；`packages/search` 当前仅导出版本常量，搜索页仍是界面壳，不能把按块检索链路标成已经接通。

图中展示主要代码依赖：实线箭头指向被调用或被依赖的模块，虚线表示实现或生成关系；数据读写另用连线文字标明。

```mermaid
flowchart TB
    subgraph L0["页面层"]
        PAGE["Astro 页面与 Base 布局"]
        VIEW["gallery.js · 页面辅助"]
    end
    subgraph L1["领域与数据访问包"]
        CORE["core · schema / model / labelplus"]
        DB["core/db 与 chunkfetch"]
        SEARCH["search · 待实现"]
    end
    subgraph L2["工具适配层"]
        TOOLS["scripts · 文件系统编排"]
        PLATFORM["platform · 配置纯函数"]
        DATA["generated · 页面数据"]
    end
    PAGE --> VIEW
    PAGE --> DATA
    TOOLS --> CORE
    TOOLS --> DB
    TOOLS --> PLATFORM
    TOOLS -->|写入| DATA
```

| 层次 | 源码入口 | 职责与边界 |
|---|---|---|
| 页面层 | [Astro 页面与 Base 布局](packages/site/src/pages/) | 组织作品、分话、阅读与搜索页面。 |
| 页面层 | [gallery.js · 页面辅助](packages/site/src/lib/gallery.js) | 处理章节索引、图像地址和标注框样式。 |
| 领域与数据访问包 | [core · schema / model / labelplus](packages/core/src/index.js) | 验证和规范化作品、章节及台词模型；不依赖 Node IO。 |
| 领域与数据访问包 | [core/db 与 chunkfetch](packages/core/src/db/index.js) | 提供 SQLite 数据库构造与分块摘要；chunkfetch 提供 Range 获取、选源与缓存。 |
| 领域与数据访问包 | [search · 待实现](packages/search/src/index.js) | 只有版本常量，未提供可用检索执行器。 |
| 工具适配层 | [scripts · 文件系统编排](scripts/) | 读取本地输入并调用 core 和 platform；Node IO 留在此层。 |
| 工具适配层 | [platform · 配置纯函数](packages/platform/src/index.js) | 解析站点配置并生成各平台配置文本，不执行部署命令。 |
| 工具适配层 | [generated · 页面数据](packages/site/src/generated/) | 页面消费的元数据、配置和台词数据。 |

<a id="section-2"></a>

## 🚀 环境与使用入口

需要 Node.js 22+ 和 npm。可以在 Codespaces 中运行下方检查与构建；Python 3 用于可选 OCR 导入及协作守卫。构建与发布是不同步骤，`npm run build` 不部署网站。


<a id="section-3"></a>

## 📚 重建与手动发布

重建需要仓库数据及有权访问的图片、检索库和部署配置；仅 Fork 源码不会取得原维护者的对象存储。配置齐全后按以下步骤执行：

1. **Fork** 本仓库（公开，CNB 账号或组织下）。
2. **填凭据**：密钥仓库 `deployment-secrets` 按「目录 = 下游仓库名、文件 = 操作名」组织。
   本项目对应 `comics-gallery/` 下的三份**脚本任务**凭据——不要写 `allow_images`
   （平台规则：声明了它，脚本任务读到的是空变量），用 `allow_slugs` + `allow_branches: main`
   收范围：
   - `publish.yml`：`R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET`
     ——对象存储的**写**凭据（`verify:manifest` / `publish:r2` / `status` 用）；
   - `deploy.yml`：按目标填 `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ACCOUNT_ID`（Cloudflare Pages）、
     `EDGEONE_API_TOKEN` + `EDGEONE_PROJECT_ID`（**项目 ID**，`makers-…`）+ `EDGEONE_PROJECT_NAME`
     （项目名，只作 CLI 的 `-n`）+ `EDGEONE_API_REGION`（token 签发区域 `china` | `global`，默认
     `china`）。EdgeOne 允许多个同名项目，流水线部署前会按 ID 核对名字与同名唯一性，不一致就拒绝
     部署（`EDGEONE_PROJECT_ID` 填项目名或 ID 填错都不会静默发错）；`GITHUB_PAGES_REPO`（`owner/repo`）与 `GITHUB_PAGES_TOKEN`
     （有 repo 写权限，流水线把 dist 推到该仓库的 `gh-pages` 分支）；
   - `notify.yml`：`NOTIFY_URL` `NOTIFY_TOKEN` `NOTIFY_TO` `NOTIFY_FROM` `NOTIFY_FROM_NAME`
     ——失败邮件。组织标准：凡是有**线上产物**或**把产物/自身部署到其他平台**的仓库都必须有；
     本仓库两者都占，所以不可省。
   （SEO 不需要密钥文件：只走 IndexNow，key 在 `site.config.yaml` 的 `seo.indexnow_key`，
   按协议公开放在站点根，不是凭据；不走百度。）
   救火用的 `purge` 另需 `EDGEONE_SECRET_ID` `EDGEONE_SECRET_KEY` `EDGEONE_ZONE_ID`，可以先不填。
   路径是**逐字匹配**的：目录或文件名差一个字，准备阶段就报 `GetFileContent: not found`。
   凭据只进密钥仓库，不进本仓库（CLAUDE.md 铁律 7）。密钥仓库只能在网页上逐文件编辑，
   改动它时按组织约定给**逐文件** Commit Message。
3. 改 [`site.config.yaml`](site.config.yaml) 里的 `site.domain` 与 `images.hosts`（图片经 CDN
   读对象存储；把 img 域名切到任何支持 S3 私有回源的 CDN 都行）。
4. **在 CNB 的 main 分支详情页点「发布」按钮**（`.cnb/web_trigger.yml`），选 `target`（首次可选
   `deploy_env=preview`）。整条流水线 = `package.json` 的 scripts，任何 CI 都能跑。图片与台词稿
   怎么进来：图片经 `IMAGES_DIR` 由 `publish:r2` 上传（或已在对象存储里），台词稿放
   `data/raw/labelplus/`，发布时填 `chapters`。
5. 把站点域名的 **CNAME** 指到新目标（TTL 300）。

当前状态（版本、部署目标、对象清单）在 [`STATUS.md`](STATUS.md)，由发布流程自动写。

<a id="怎么跑"></a>

<a id="section-4"></a>

## 🚀 怎么跑

维护者没有电脑：一切在手机浏览器 + Codespaces 里完成（CNB 的发布按钮与构建页都在
网页上；CLAUDE.md 铁律 9）。

```bash
npm ci
npm run check     # 预算守卫 + 配置生成物同步 + lint —— 提交前必过
npm test          # core 解析器 / 归一化 / DB 构建的单测
npm run build     # 全量静态构建（dry-run，不发布）
```

`npm run build` = `build:config → build:manifest → build:db → build:site → build:index → build:sitemap`。
发布（`verify:manifest`、`publish:r2`、`deploy:*`、`status`、`push:search`）只由 `.cnb.yml` 的
发布流水线手动触发；`ingest:labelplus` 把 `data/raw/labelplus/` 下的 LabelPlus 稿转成 `data/text/`。

<a id="目录"></a>

<a id="section-5"></a>

## 🏛️ 目录

```
.cnb.yml                流水线：main push 检查（+ last-green）、手动发布、归档分支（铁律 6）
.cnb/web_trigger.yml    main 分支详情页的按钮（发布 / 检查 / 归档）
site.config.yaml        唯一配置源：域名、缓存、响应头、重定向、功能开关（铁律 5）
data/meta/<series>.yaml 作品 / 期 / 话 / 页 元数据（人工维护）
data/text/<series>/…    台词层，每话一文件（ingest 生成）
data/raw/labelplus/     LabelPlus 原始稿（手机在 GitHub 网页上传），ingest 的输入
packages/core           schema、LabelPlus 解析、归一化、DB 构建、取块层 —— 只用 Web 标准 API
packages/site           Astro：每话一个 HTML，阅读器，sitemap
packages/search         检索包占位；浏览器检索执行器尚未实现
packages/platform       三平台配置生成器与函数入口壳；生成物在 generated/
scripts/                构建期脚本（允许 Node），每个 = package.json 的一条 script
tools/                  守卫：agent-guard、分支体检、commit-msg / pre-push 钩子
.github/workflows       （已迁走；CNB 流水线见上面的 .cnb.yml）
dist/  out/             产物（不入库）
```

<a id="参与开发"></a>

<a id="section-6"></a>

## 📚 参与开发

直接提 `main`，没有 PR 流程；一功能一 commit，Conventional 前缀 + 中文；提交前
`npm run check && npm test` 全过。规则见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，
AI 协作者的硬约束见 [`CLAUDE.md`](CLAUDE.md) 与 [`AGENTS.md`](AGENTS.md)。
钩子会在 Claude / Codex 跑过第一条命令后自动生效；人类手敲的克隆跑一次
`bash tools/install-hooks.sh`。

<a id="许可"></a>

<a id="section-7"></a>

## 📜 许可

GPL-3.0（见 [LICENSE](LICENSE)）。`tools/` 下守卫脚本的来源见 [`tools/NOTICE.md`](tools/NOTICE.md)。
