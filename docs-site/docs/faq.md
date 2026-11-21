# 部署与运行排错 FAQ

本页聚焦本地构建、环境依赖、检查报错与多平台发布阶段的实际故障排查；选型类问题请参见仓库根 README，内部契约说明请查阅 Stage 2。

## 构建与校验类报错

### 1. `build:site` 报错 `manifest.sourceSha256`、域名或版本号不一致

- **现象**：运行 `pnpm run build:site` 时抛出错误，提示清单与当前站点内容指纹、域名或版本不匹配，拒绝写入 `dist/`。
- **根因**：此前单独改过 `data/` 或 `site.config.yaml`，或者设置了不同的 `RELEASE_VERSION`，但跳过 `build:manifest` 与 `build:db` 直接构建站点，导致页面准备绑定的 `gallery.searchDb` 与内容失配。
- **排查命令**：
  ```sh
  pnpm run check:data
  cat out/manifest.json | head -n 20
  ```
- **解决方案**：按完整顺序重新执行全量构建 `pnpm run build`（它会串联 `build:config` → `build:manifest` → `build:db` → `build:site` → `build:index` → `build:sitemap`）。

### 2. `pnpm run check` 报错发现 `astro>sharp` 或原生构建依赖

- **现象**：`check` 报告锁文件或包依赖目录出现 `sharp`、libvips 或非许可 `allowBuilds` 标记。
- **根因**：直接用旧工具安装了可选依赖或修改了 `pnpm-workspace.yaml` 中的 `overrides: { astro>sharp: '-' }`，引入了 LGPL 原生图像二进制，破坏纯 JS/Web 标准发布约束。
- **排查命令**：
  ```sh
  grep -n "sharp" pnpm-lock.yaml pnpm-workspace.yaml || true
  ```
- **解决方案**：恢复 `pnpm-workspace.yaml` 里的 `astro>sharp: '-'` 覆盖策略，仅允许白名单内的 `esbuild`，清理依赖后重新执行 `pnpm install --frozen-lockfile`。

### 3. `docs-site` 运行或测试报 `Cannot find module 'vitepress'`

- **现象**：执行 `pnpm test` 或 `pnpm --dir docs-site run docs:build` 时失败，提示文档依赖未安装。
- **根因**：`docs-site/` 是刻意与根工作区隔离的独立包与独立锁文件（防止文档工具依赖污染业务生产审计与锁文件）。根目录 `pnpm install` 不会安装 `docs-site/node_modules`。
- **排查命令**：
  ```sh
  ls -la docs-site/node_modules/.bin/vitepress
  ```
- **解决方案**：
  ```sh
  pnpm --dir docs-site install --frozen-lockfile
  pnpm run test:docs
  ```

### 4. `check` 提示 `README.md` / `README.en.md` 锚点链接失效

- **现象**：`checkReadmeLinks` 报错指出某行 `#...` 片段找不到对应标题。
- **根因**：修改 README 标题文字后，目录或头部快捷跳转 `#slug` 未同步；或手工写入了保留大写、多连字符规则不符的锚点（`readme-links.mjs` 规则为：小写 → 去非字母数字空白下划线连字符 → 空白逐个转 `-`）。
- **排查命令**：
  ```sh
  node --test scripts/test/readme-links.test.mjs
  ```
- **解决方案**：将 `#fragment` 改为与目标标题完全一致的规范锚点并重跑 `pnpm run check`。

## 多平台部署与预算报错

### 5. ESA 或 `--target all` 在发布前被预算检查拦截

- **现象**：`DEPLOY_TARGET=esa pnpm run check` 或 `release` 报错超出 2,000 文件或 1,024,000,000 B。
- **根因**：ESA 硬限制为 2,000 文件与 1,024,000,000 B，而 Pagehaven 会额外预留 1 个文件、4,096 B 给本次部署的随机验证文件，因此业务静态产物最多容纳 **1,999 文件**（含首页、搜索、书架、404、字体、分片索引、所有系列与话 HTML）。
- **排查命令**：
  ```sh
  DEPLOY_TARGET=all pnpm run check
  find dist -type f | wc -l
  ```
- **解决方案**：精简无必要的多余重定向或静态文件，或将超出 ESA 容量的作品目录部署到支持 18,000 守卫上限的 `workers` / `github` / `edgeone`。

### 6. Workers / ESA 部署 CLI 返回退出码 0，但发布任务判定失败

- **现象**：`wrangler` 或 `edgeone` / `esa-cli` 上传看似完成，但 `deploy.mjs` 报错“随机验证文件不匹配”且拒绝写入成功回执与移动 `manifest.json`。
- **根因**：验证根地址（如 `WORKERS_DEPLOY_URL` 或 `ESA_DEPLOY_URL`）实际仍路由到了另一家 CDN、旧部署缓存或错误的预览项目，导致读回的不是本次生成的随机验证 UUID/指纹。
- **排查命令**：核对目标环境变量对应的预览/staging 域名是否真正指向该平台当前环境，并且未被中间代理缓存旧产物或改写为重定向。
- **解决方案**：确保每个目标的验证地址直达该目标本次上传实例（不可用绑定在 A 平台的自定义域名去验收 B 平台），重新运行该目标部署并确认 `release:activate` 前所有目标回执一致。

### 7. 在非生产预览中使用 `github` 或 `all` 直接被拒绝

- **现象**：设置 `DEPLOY_ENV=preview` 并选 `github` 或 `all` 时立即报错退出。
- **根因**：GitHub Pages 当前仅映射单一 `gh-pages` 生产分支，未配置独立预览环境，`releasePlan` 在部署前主动阻断以免覆盖线上页面。
- **解决方案**：预览部署显式选择 `edgeone`、`esa`、`workers` 或 `cloudflare`。

## 浏览器检索与阅读器故障

### 8. 搜索页提示无法加载检索库或提示“超过整份下载上限”

- **现象**：输入 2 个字以上关键词触发检索时失败，提示网络错误、域名全部失败、SHA-256 不符或库体积超限。
- **根因**：常见原因有三类：
  1. CDN 回源规则或 CORS 未放行 `https://<site.domain>` 跨域请求；
  2. `db/gallery-<version>.sqlite` 被 CDN 压缩篡改、缓存截断导致字节数或 SHA-256 与构建清单不一致；
  3. 整库模式或回退整库时，`gallery.sqlite` 体积超过了 `site.config.yaml` 中 `db.whole_download_max_bytes`（默认 30 MiB = `31,457,280` 字节）。
- **排查命令**：
  ```sh
  ls -lh out/db/
  grep -n "whole_download_max_bytes" site.config.yaml
  ```
- **处理方法**。检查 CDN 的 CORS 规则、未压缩的 206 响应和暴露给浏览器的 `Content-Range` 头。对超过整库上限的库，开启 `features.range_search` 并完整重建。

### 9. 为什么启用“增强分页”后，条漫模式或点击台词搜索结果会自动切回标准阅读器？

- **现象**：勾选了增强分页控件（`comimi_reader: true`），但在切换到长条阅读、勾选“显示文字”或从 `/search/` 带 `#p<n>b<i>` 进入章节时，界面提示切回标准阅读器。
- **根因**：这是有意设计的安全回退边界（`packages/site/src/lib/enhanced-reader.js`）。增强分页只负责常规单/双页翻页呈现，而长条浏览、台词透明文字层与 `#p<n>b<i>` 气泡定位高亮均由标准阅读器统一保证兼容性与精确坐标。
- **解决方案**：无需手动修复；切回标准单页/双页并关闭文字层后，增强分页会自动恢复激活。
