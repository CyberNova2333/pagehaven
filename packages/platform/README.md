# @gallery/platform

[返回「页间 · Pagehaven」项目说明](../../README.md)

页间 · Pagehaven 的平台绑定层（CLAUDE.md 铁律 2）：`site.config.yaml` 的 schema、三平台配置生成器
（Cloudflare `_headers` / `_redirects`、EdgeOne `edgeone.json`）、将来的函数入口壳。
全是纯函数；碰文件系统与跑部署命令的在 `scripts/`。

每一处平台绑定都必须有降级：验收基线是 GitHub Pages——没有响应头、没有重定向、没有函数。

`db.prefix` 与浏览器及发布计划共用 core 的对象路径契约：以 `/` 结尾，各段仅含 ASCII
字母、数字、下划线、连字符和点，不能有空段或独立的 `.`、`..`。不支持的前缀在构建前报错；
这项校验对三平台相同，不依赖响应头、重定向或函数。
