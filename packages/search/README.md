# @gallery/search

浏览器端台词检索：sqlite-wasm 读 `gallery-<date>.sqlite`，零服务端（ARCHITECTURE §4、§6）。

- `loadGalleryDb`：GET `db/manifest.json` 拿当前版本 → 整份下载 → 按 manifest 的 size / sha256
  校验 → `openGalleryDb` 在内存打开（§6 的「整份下载」退化路径）。多个图片域名按顺序回退；
  所有读取都经 CDN 域名（铁律 7）。
- `queryLines`：查询串走与索引相同的 `normalizeText`（NFKC → 去符号 → OpenCC 繁→简 → 小写）；
  ≥ 3 字走 FTS5 trigram 的 MATCH、恰好 2 字退 LIKE、1 字拒绝。结果 join 回 bbox 与话，
  链到 `/<series>/<issue>/<chapter>/#p<n>b<i>`。
- `mountSearch`：搜索页接线（约定的 `#search-*` id），首次搜索才加载库；加载或查询失败只影响
  检索，作品与话页面照常。

只用 Web 标准 API（铁律 1）。`requestChunkSize` 来自 `site.config.yaml`，与 DB 的
`page_size` 一致由 `npm run check` 守卫。

按 HTTP Range 分块读取（需要自定义 sqlite 的同步 VFS，浏览器里只能靠 Worker + 同步 XHR）
与函数版检索（Hono，`features.search_function`）是后续优化，`loadGalleryDb` / `queryLines`
的接口不变。整份下载路径的上限是 `db.whole_download_max_bytes`（30 MB）。
