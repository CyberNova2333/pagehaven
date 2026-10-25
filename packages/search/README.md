# @gallery/search

浏览器端台词检索：sqlite-wasm 读取版本化检索库，零服务端。

- `loadGalleryDb`：优先使用 `config.db.release` 指定的构建版本，经 CDN 整份下载，按
  size / sha256 校验后在内存打开。`release: null` 表示此站点版本尚未构建检索库，
  不会改读生产 manifest；只有旧调用方完全没有 `release` 属性时，才读取当前 manifest。
  每个源的 manifest 都须通过 key / size / sha256 校验；不合法或下载失败时尝试备用源。
- 整份下载受 `db.whole_download_max_bytes` 限制（缺省 30 MB）：先检查 manifest 尺寸，
  再检查响应头与实际流读取字节数。源多发字节时立即取消，不缓存完整的超额响应。
- `prepareQuery` / `queryLines`：查询与索引共用 `normalizeText`；归一化后至少 3 字走
  FTS5 trigram MATCH，恰好 2 字走 LIKE，不足 2 字拒绝。trigram 边界固定为 3，
  不受旧调用方传入的阈值影响。支持 `seriesId` 作品过滤、`offset` 分页、每批最多 50 条，
  返回 `hasMore`，结果链到 `/<series>/<issue>/<chapter>/#p<n>b<i>`。
- `mountSearch`：首次有效查询才加载库。`coverage` 提供总话数、已有台词稿话数和文本框数；
  没有作品时提示目录为空，有作品但无台词时提示尚未收录，两种情况都不下载数据库。
  结果提供作品筛选和「加载更多」，
  只在没有后续结果时显示确切数量。加载失败允许再次尝试；销毁时取消请求并释放数据库。

页面仍保留 `#search-form`、`#search-input`、`#search-status`、`#search-results`、
`#search-config` 这组必需 id，增加可选的 `#search-series`、`#search-more`、
`#search-coverage`。`config.coverage` 的形状为
`{ chapters: 总话数, withText: 有台词稿的话数, boxes: 文本框数 }`。

只用 Web 标准 API。HTTP Range 取块层已经在 core 中存在，但 sqlite VFS 与 Worker 的
接线、函数版检索仍未实现；当前实际路径是受限的整库下载。单字拒绝、两字 LIKE、
固定版本、下载上限、备用源、覆盖率和翻页均由包内测试验证。
