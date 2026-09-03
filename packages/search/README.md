# @gallery/search

浏览器端台词检索：sqlite-wasm 通过 `@gallery/core` 的取块层按 HTTP Range 经 CDN 读
`gallery-<date>.sqlite`，零服务端（ARCHITECTURE §6）。可选的函数版检索（Hono）只作加速，
前端探测不到 `/api/search` 就自动回退浏览器端（铁律 3）。

只用 Web 标准 API（铁律 1）。`requestChunkSize` 来自 `site.config.yaml`，与 DB 的
`page_size` 一致由 `npm run check` 守卫。
