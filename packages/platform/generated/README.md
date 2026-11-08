# 生成物，不要手改

这里的 `_headers` / `_redirects` / `edgeone.json` 由 `pnpm run build:config` 从仓库根的
`site.config.yaml` 生成（CLAUDE.md 铁律 5）。`pnpm run check` 会重新生成一遍并逐字节比对，
不同步就打回。要改响应头、缓存或重定向：改 `site.config.yaml`，再跑 `pnpm run build:config`。

`build:site` 在 `features.platform_config` 打开时把它们复制进 `dist/`；关掉就是
GitHub Pages 那条纯静态基线（铁律 2）。
