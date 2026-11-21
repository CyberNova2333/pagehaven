# 项目概览与快速上手

页间（Pagehaven）是为静态托管免费层设计的**数字漫画馆与台词检索引擎**。它把漫画元数据（YAML）与校对台词稿（JSON / LabelPlus）编译为纯静态 HTML、作品分片索引和可在浏览器内运行的 SQLite Wasm 全文库，实现**零服务端、零月付账单、长期免维护可存活**的阅读体验。

## 能做到什么程度与明确不能做什么

| 维度 | 能做到什么程度（核心支持） | 明确不能做什么（非目标与硬限制） |
| --- | --- | --- |
| 归档与阅读 | 作品 / 期 / 话三级归档，无脚本保留全页与文字层；单页、长条二分定位、双页与可选 Comimi | 不做用户注册登录、评论区、服务端渲染（SSR）或 Web 在线图片后台上传 |
| 台词检索 | `normalizeText` + SQLite Wasm（≥3 字 `MATCH` / 2 字 `LIKE`）跳转到 `#p<n>b<i>` | 归一化 `<2` 字直接拒绝；默认限 `30 MiB` 整库下载；未校对 OCR 不自动入正式索引 |
| 分块与书架 | `pagehaven-reading-backup` 白名单迁移（≤ `5 MiB` / `20,000` 条）；`chunkfetch` 分块探测原语已就绪 | 不做跨端账号云同步；`features.range_search` 默认关闭 |
| 四端部署发布 | 同一 `dist/` 兼容 EdgeOne、ESA（≤ `1,999` 业务文件）、GitHub Pages、Workers 与 R2 原子激活 | `github` 与 `all` 拒绝预览模式；生产发布禁止保留 `example.org` 与明文凭据 |

> 需要按条目查阅配置 Schema、核心包函数签名与发布命令示例？可直接前往交互式 [API 与组件参考](/api-reference/)。

## 环境前提

- **Node.js**：`>=22.19.0`（仓库根目录包含 `.nvmrc`）
- **pnpm**：`>=10.0.0`（锁文件基于 `pnpm@12.6.0` 维护，业务包使用 `workspace:*` 显式链接）
- **文档站独立依赖**：`docs-site/` 使用独立的 `docs-site/package.json` 与锁文件，根目录安装不会装入 VitePress

## 第一次本地跑通

安装根依赖后，运行 `pnpm run demo` 即可阅读《潮汐手记》。打开端口 4321，点「找作品」后输入「归航灯」，或在台词搜索中输入「灯塔」。后者直接定位到漫画气泡；翻页后可从首页续读。Codespaces 使用 `pnpm run demo --host 0.0.0.0`。

### 1. 安装依赖与初始化配置

```sh
pnpm install --frozen-lockfile
# 交互式引导写入站点标题、正式域名、图片域名与目标平台
pnpm run init
# 或非交互式预览修改（--write 才会落盘）
pnpm run init -- --title "我的漫画馆" --domain manga.example.com --image-host img.example.com --target edgeone --dry-run
```

如需在浏览器中直观调整名称、Logo、色调预设（`paper` / `ocean` / `plum`）或文字层/增强分页开关，可运行本地配置器：

```sh
pnpm run customize
# 默认监听 http://127.0.0.1:4318/#token=<会话随机凭证>；Codespaces 下可加 -- --host 0.0.0.0
```

`customize` 仅编辑 `site.config.yaml` 并将原文件备份到 `out/customize/`，提交并手动触发发布流水线后才会对读者生效。

### 2. 全量构建、检查与本地预览

```sh
pnpm run build
pnpm run check
pnpm --filter @gallery/site run preview
```

默认状态下，仓库内置 `data/` 目录只有结构说明文件（空内容模板），构建会产出合法的空站页面、空检索库和 `/search/` 空态提示。若想立即查看带多话漫画与可检索台词的完整示例效果，可临时指向测试夹具构建并预览：

```sh
DATA_DIR=packages/core/test/fixtures/data DIST_DIR=/tmp/pagehaven-dist OUT_DIR=/tmp/pagehaven-out pnpm run build
pnpm --filter @gallery/site run preview -- --port 4321
```

注意：`packages/site` 的 Astro 静态预览默认读取工作区配置输出目录（默认 `dist/`），直接用 `pnpm run build && pnpm --filter @gallery/site run preview` 即可在 `http://localhost:4321` 打开本地预览；开发热调试阶段也可运行 `pnpm --filter @gallery/site run dev`（使用前需先运行一次 `pnpm run build:config` / `build:site` 写入 `packages/site/src/generated/`）。

## 下一步阅读

- 需要配置四端部署、私有 R2 桶与环境变量：前往 [多模式运行与多平台部署](/docs/deployment)
- 需要导入 LabelPlus 或 OCR 台词稿：前往 [配置、数据与前端契约](/docs/configuration)
- 构建或检查报错：前往 [部署与运行排错 FAQ](/docs/faq)
