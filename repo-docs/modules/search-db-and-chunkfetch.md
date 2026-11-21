# 检索与分块模块

本模块涵盖 `@gallery/core/db` 的 SQLite Wasm 建库与分块摘要、`@gallery/search` 的浏览器端按需加载与查询调度，以及 `@gallery/core/chunkfetch` 的独立多源 Range 校验基建。

## SQLite Wasm 建库与分块摘要 (`@gallery/core/db`)

[建库模块](../../packages/core/src/db/build.js) 通过 `@sqlite.org/sqlite-wasm` 在内存构造检索数据库并导出字节数组：
- **页对齐与单文件约束**：首条语句强制执行 `PRAGMA page_size=<db.page_size>`（512–65536 之间 2 的幂，当前配置 4096），导出前设置 `PRAGMA journal_mode=DELETE` 并执行 `VACUUM`，保证文件非 WAL（文件头第 18/19 字节为 1）且无空闲页；
- **表与外部内容索引**：建有 `series`、`issues`、`chapters`、`pages`、`lines` 五张实体表、4 条外键查询索引以及外部内容虚表 `lines_fts USING fts5(text_norm, content='lines', content_rowid='id', tokenize='trigram')`，在全事务插完数据后显式执行 `INSERT INTO lines_fts(lines_fts) VALUES('rebuild')`；空内容库也产出合法 0 行表结构；
- **分块摘要清单**：[分块计算模块](../../packages/core/src/db/chunks.js) 使用 Web 标准 `crypto.subtle.digest('SHA-256', ...)` 计算与 `db.chunk_size`（默认 65,536 字节）对齐的 `{ version: 1, totalBytes, chunkSize, sha256, chunks[] }`，保存为 `gallery-<version>.sqlite.chunks.json`。

## 浏览器端加载与混合查询 (`@gallery/search`)

[检索加载器](../../packages/search/src/load.js)、[查询调度](../../packages/search/src/query.js) 与 [页面挂载](../../packages/search/src/mount.js) 在 `/search/` 页协同执行：

1. **判断是否需要台词检索**。搜索页默认显示台词输入框。首次进入「找作品」（`/search/#titles`）才读取作品目录，按正题、别名、作者等过滤全部作品。结果每次追加 50 部。切回台词后仍可返回先前的作品筛选结果。台词表单先检查 `coverage`，再用 `foldText` 折叠输入、转小写并按 Unicode 码位计数。无台词或不足两字时就地提示。首次有效查询才加载 SQLite 运行时和 OpenCC 词典，带 `?q=` 的直达链接也走同一路径。
2. **读取固定发布版本**。搜索页绑定 `config.db.release`。默认从 CDN 下载整库，读取响应流时执行 `db.whole_download_max_bytes` 上限，默认 30 MiB，整库 SHA-256 匹配后再打开。开启 `features.range_search` 后，首次有效查询创建 Worker。Worker 先验证页面固定的 `chunksSha256`，再用清单中的摘要逐块校验。旧数据库指针缺少清单摘要时沿用整库路径。
3. **混合查询调度 (`queryLines`)**：
   - 归一化长度 **`>= 3`**：对引号转义为 FTS5 短语 `ftsPhrase(normalized)`，查询 `lines_fts MATCH ?`；
   - 归一化长度 **`=== 2`**：因 trigram 索引最小为 3 字符，转用 `likePattern(normalized)` 执行 `l.text_norm LIKE ? ESCAPE '\'` 扫表（可选拼入 `s.id = ?` 过滤）；
   - 按 `s.sort, s.id, i.number, i.id, c.number, c.id, p.n, l.ord, l.id` 排序，每次取 `limit + 1` 行计算 `hasMore`（默认每批最多 50 条），并生成带气泡锚点的直达链接 `/<series>/<issue>/<chapter>/#p<n>b<i>`。

| 查询或加载输入 | 预期行为与结果 |
| --- | --- |
| 查询 `"的"` 或纯标点 `"……！？"` | 页面显示最少字数提示，无需加载台词检索代码或数据库 |
| 查询 `"希望"`（归一化 2 字） | `mode: 'like'`，绕开 FTS5 trigram 执行带转义的 `LIKE` 查询 |
| 整库下载时 `.sqlite` 响应流比 manifest 声明多出 1 字节或超出 30 MiB 上限 | `readBoundedResponse` 中 `reader` 立即 `controller.abort()` 并抛错，拒绝交给 Wasm |

## 按需读取与多源切换 (`@gallery/core/chunkfetch`)

[分块文件组装](../../packages/core/src/chunkfetch/chunked-file.js) 已实现并单测多源探测（`probe`）、并发去重（`SharedJob`）、LRU 块缓存、EMA 源选择（`SourceSet`）、逐块 `crypto.subtle` SHA-256 校验，以及所有源无视 HTTP Range 时向上抛出 `needs-whole`（避免被判为网络耗尽而无法触发整库降级）。

Worker 把 SQLite 的同步读请求交给分块读取器。相同块可从缓存复用，坏块会尝试备用 CDN。所有源忽略 Range 时，预算内改用整库重试同一查询，超限则向读者显示错误。Worker 无法启动时，页面也可以走整库路径。两字 `LIKE` 可能扫过许多数据页，实际流量取决于查询。 [只读 VFS](../../packages/core/src/db/vfs.js) · [Worker 会话](../../packages/search/src/worker.js) · [回归测试](../../packages/search/test/range-vfs.test.js)

## 验证钩子

- SQLite 建库与对象路径测试：[db.test.js](../../packages/core/test/db.test.js)、[build-db.test.mjs](../../scripts/test/build-db.test.mjs)、[object-prefix.test.mjs](../../scripts/test/object-prefix.test.mjs)
- 检索查询与空态回归：[search.test.js](../../packages/search/test/search.test.js)、[empty-state.test.js](../../packages/search/test/empty-state.test.js)、[search-page.test.js](../../packages/site/test/search-page.test.js)
- 分块 Range 与校验单测：[chunkfetch.test.js](../../packages/core/test/chunkfetch.test.js)

## 延伸阅读

- 归一化与模型来源：[数据模型与归一化模块](data-model-and-normalization.md)
- 前端搜索挂接与深链高亮跳转目标：[阅读器与书架模块](static-reader-and-bookmarks.md)

证据状态：除特别标注外，本页基于当前源码已确认。
