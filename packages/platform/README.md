# @gallery/platform

平台绑定层（CLAUDE.md 铁律 2）：`site.config.yaml` 的 schema、三平台配置生成器
（Cloudflare `_headers` / `_redirects`、EdgeOne `edgeone.json`）、将来的函数入口壳。
全是纯函数；碰文件系统与跑部署命令的在 `scripts/`。

每一处平台绑定都必须有降级：验收基线是 GitHub Pages——没有响应头、没有重定向、没有函数。
