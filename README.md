# comics-gallery · 漫画画廊

> **静态漫画阅读、元数据导航与浏览器全文检索。**

作品 / 期 / 话 / 页浏览，期数等元数据检索，台词**子串级**全文检索，自动 sitemap。
产物是纯静态文件，托管在 Cloudflare Pages / EdgeOne Makers / GitHub Pages 三者之一，
随时切换；图片与检索库在对象存储，经 CDN 读取。设计与决策见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。


**阅读导航**

[🏛️ 架构与职责边界](#section-1) · [🚀 环境与使用入口](#section-2) · [📚 重建与手动发布](#section-3) · [🚀 怎么跑](#section-4) · [🏛️ 目录](#section-5) · [📚 参与开发](#section-6) · [📜 许可](#section-7)

---

<a id="section-1"></a>

## 🏛️ 架构与职责边界

| 模块 / 入口 | 职责 |
|---|---|
| [数据输入](data/) | 作品元数据与按话组织的台词稿 |
| [构建脚本](scripts/) | 生成页面、索引、数据库和站点地图 |
| [浏览器模块](packages/) | 阅读器、检索与可替换的平台适配 |
| [发布状态](STATUS.md) | 由手动发布流程记录交付状态；当前文件仍标记尚未发布 |

<a id="section-2"></a>

## 🚀 环境与使用入口

需要 Node.js 22+ 和 npm。可以在 Codespaces 中运行下方检查与构建；Python 3 用于可选 OCR 导入及协作守卫。构建与发布是不同步骤，`npm run build` 不部署网站。


<a id="section-3"></a>

## 📚 重建与手动发布

重建需要仓库数据及有权访问的图片、检索库和部署配置；仅 Fork 源码不会取得原维护者的对象存储。配置齐全后按以下步骤执行：

1. **Fork** 本仓库（公开）。
2. **填 secrets**（Settings → Secrets and variables → Actions）：
   `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET`——对象存储的**写**凭据；
   要发 Cloudflare Pages 再加 `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ACCOUNT_ID`；
   要发 EdgeOne 再加 `EDGEONE_API_TOKEN` `EDGEONE_PROJECT_ID`（值填 Makers 的**项目名**，首次
   先选 `deploy_env=preview` 核对）；GitHub Pages 不需要额外 secrets。救火用的 `purge` 另需
   `EDGEONE_SECRET_ID` `EDGEONE_SECRET_KEY` `EDGEONE_ZONE_ID`，可以先不填；要主动向百度推送
   新页面再加 `BAIDU_PUSH_TOKEN`（IndexNow 的 key 填在 `site.config.yaml` 的 `seo.indexnow_key`）。
3. 改 [`site.config.yaml`](site.config.yaml) 里的 `site.domain` 与 `images.hosts`（图片经 CDN
   读对象存储；把 img 域名切到任何支持 S3 私有回源的 CDN 都行）。
4. **Actions → 发布 → Run workflow**，选 `target`（首次可选 `deploy_env=preview`）。整条流水线 =
   `package.json` 的 scripts，任何 CI 都能跑。图片与台词稿怎么进来：图片经 `IMAGES_DIR` 由
   `publish:r2` 上传（或已在对象存储里），台词稿放 `data/raw/labelplus/`，发布时填 `chapters`。
5. 把站点域名的 **CNAME** 指到新目标（TTL 300）。

当前状态（版本、部署目标、对象清单）在 [`STATUS.md`](STATUS.md)，由发布流程自动写。

<a id="怎么跑"></a>

<a id="section-4"></a>

## 🚀 怎么跑

维护者没有电脑：一切在手机浏览器 + GitHub App / Codespaces 里完成（CLAUDE.md 铁律 9）。

```bash
npm ci
npm run check     # 预算守卫 + 配置生成物同步 + lint —— 提交前必过
npm test          # core 解析器 / 归一化 / DB 构建的单测
npm run build     # 全量静态构建（dry-run，不发布）
```

`npm run build` = `build:config → build:manifest → build:db → build:site → build:index → build:sitemap`。
发布（`verify:manifest`、`publish:r2`、`deploy:*`、`status`、`push:search`）只由 `release.yml` 手动触发；
`ingest:labelplus` 把 `data/raw/labelplus/` 下的 LabelPlus 稿转成 `data/text/`。

<a id="目录"></a>

<a id="section-5"></a>

## 🏛️ 目录

```
site.config.yaml        唯一配置源：域名、缓存、响应头、重定向、功能开关（铁律 5）
data/meta/<series>.yaml 作品 / 期 / 话 / 页 元数据（人工维护）
data/text/<series>/…    台词层，每话一文件（ingest 生成）
data/raw/labelplus/     LabelPlus 原始稿（手机在 GitHub 网页上传），ingest 的输入
packages/core           schema、LabelPlus 解析、归一化、DB 构建、取块层 —— 只用 Web 标准 API
packages/site           Astro：每话一个 HTML，阅读器，sitemap
packages/search         浏览器端检索（sqlite-wasm + Range）；可选 Hono 函数壳
packages/platform       三平台配置生成器与函数入口壳；生成物在 generated/
scripts/                构建期脚本（允许 Node），每个 = package.json 的一条 script
tools/                  守卫：agent-guard、分支体检、commit-msg / pre-push 钩子
.github/workflows       checks.yml（push 复验 + last-green）、release.yml（只手动）、归档分支
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
