# 项目概览与快速上手

页间（Pagehaven）是为静态托管免费层设计的**数字漫画馆与台词检索引擎**。它把漫画元数据（YAML）与校对台词稿（JSON / LabelPlus）编译为纯静态 HTML、作品分片索引和可在浏览器内运行的 SQLite Wasm 全文库，实现**零服务端、零月付账单、长期免维护可存活**的阅读体验。

## 适用范围与非目标

| 纳入核心支持 | 明确排除（非目标） |
| --- | --- |
| 作品 / 期 / 话三级结构化归档与多图源自适应 | 用户注册、账号登录、评论系统或服务端会话 |
| 单页、长条、双页阅读，RTL/LTR 切换与本地书架备份 | 在线后台上传图片、服务端渲染（SSR）或 VPS 常驻进程 |
| 浏览器端 FTS5 trigram + LIKE 台词检索与 `#p<n>b<i>` 跳转 | 无人工校对直接发布 OCR 原稿入检索库 |
| EdgeOne、ESA、GitHub Pages、Workers 四端同源构建 | 绑定某一云厂商专有函数才能浏览的基础页面 |

## 环境前提

- **Node.js**：`>=22.19.0`（仓库根目录包含 `.nvmrc`）
- **pnpm**：`>=10.0.0`（锁文件基于 `pnpm@12.6.0` 维护，业务包使用 `workspace:*` 显式链接）
- **文档站独立依赖**：`docs-site/` 使用独立的 `docs-site/package.json` 与锁文件，根目录安装不会装入 VitePress

## 第一次本地跑通

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
