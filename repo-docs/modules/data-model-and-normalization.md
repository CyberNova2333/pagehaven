# 数据模型与归一化模块

本模块以纯 Web 标准（zero `node:*`）定义漫画作品树数据结构、对象路径安全规则、LabelPlus/OCR 台词导入门禁与索引/查询共用的五步文本归一化。

## 模型结构与安全路径契约

[数据结构验证](../../packages/core/src/schema.js) 与 [领域模型](../../packages/core/src/model.js) 将目录组织为 `Series → Issue → Chapter → Page → TextBox` 五层：
- `SeriesSchema` / `IssueSchema` / `ChapterSchema` / `PageSchema` 校验短标识格式、`sort` 顺序、封面及每页 WebP 对象 key 和像素尺寸；
- `ChapterTextSchema` 要求每个台词框 `x`, `y`, `w`, `h` 落在 `[0, 1]` 归一化区间，确保任意屏幕宽度下气泡位置精确重合；
- [安全对象路径](../../packages/core/src/object-path.js) 中的 `isSafeObjectPrefix` 与 `isSafeObjectKey` 只允许无需 URL 转义的安全 ASCII 相对路径，拒绝空格、`..`、`.`、空段或控制字符；构建端清单与浏览器检索加载器共享同一契约。

## LabelPlus 与 OCR 人工门禁导入

- **LabelPlus 解析与导入**：[LabelPlus 解析器](../../packages/core/src/labelplus.js) 严格精确匹配 `>>>>>>>>[文件名]<<<<<<<<` 与 `----------------[编号]----------------[x,y,分组]` 分隔符，防止正文中出现的 `————` 或 `>>>` 装饰行被误切；对仅命中前缀但整行格式有误的可疑行输出带 1 起行号的 `warnings`。命令行入口 [ingest-labelplus.mjs](../../scripts/ingest-labelplus.mjs) 支持 `--dry-run` 预览、`CHAPTERS` 章节过滤与 `LABELPLUS_PAGES=auto|number|sequence` 页码映射策略。
- **OCR 人工校对双阶段门禁**：[ingest-ocr.mjs](../../scripts/ingest-ocr.mjs) 默认要求显式传入 `CHAPTERS`，仅把待校对 JSON 与对照 HTML 写到 `OUT_DIR` 供人工核对，**严禁直接写入 `data/text/`**；只有人工修正并放入 `data/raw/ocr/` 后附带 `--accept-reviewed` 运行，才会正式写入 `data/text/`。

## 五步幂等台词归一化 (`normalizeText`)

[台词归一化](../../packages/core/src/normalize.js) 为构建索引的 `text_norm` 列与前端查询输入提供严格幂等的纯函数流水线（`normalizeText(normalizeText(s)) === normalizeText(s)`）：

1. **首轮 `NFKC`**：将全角字符、半角假名与康熙部首（例如 `U+2F9E ⾞ → 車`）折回标准汉字，确保后续 OpenCC 词典可识别；
2. **正则剥离 `STRIP_RE`**：剔除 `\p{P}` 标点、`\p{S}` 符号、`\p{Z}` 分隔符、`\p{Cc}/\p{Cf}/\p{Co}/\p{Cs}` 控制/格式/私用/代理字符与 `\p{Variation_Selector}`；故意不使用 `\p{C}`，防止其中包含的未分配码位 `Cn` 在构建端 Node 与旧手机浏览器 Unicode 表版本之间出现一端保留、一端删除的分歧；
3. **次轮 `NFKC`**：将剥离零宽分隔符后变成相邻的组合符号与基字重新合成；
4. **`opencc-js/t2cn`（`from: 't', to: 'cn'`）**：仅引入约 110 KB 单向繁转简词典，浏览器端离线执行、零外部词典请求；
5. **`.toLowerCase()`**：统一拉丁字母大小写。

| 输入样本或边界 | 处理结果 |
| --- | --- |
| `"Ｈｅｌｌｏ，契約！"` 或含 `U+2F9E` 康熙部首 | 两轮 NFKC + 去标点 + OpenCC → `"hello契约"`（构建端与查询端一致） |
| 含未分配扩展码位 `Cn` 的新字 | 原样透传不随引擎 Unicode 版本增删，保持双端一致（文档内已知限制：CJK 部首补充区 `U+2E80–2EF3` 多数归类为 `So` 会被当作符号移除） |
| `ingest:ocr` 未带 `--accept-reviewed` | 仅在 `OUT_DIR` 输出草稿与校对 HTML，`data/text/` 保持未改 |

## 验证钩子

- 核心单测：[schema.test.js](../../packages/core/test/schema.test.js)、[model.test.js](../../packages/core/test/model.test.js)、[labelplus.test.js](../../packages/core/test/labelplus.test.js)、[normalize.test.js](../../packages/core/test/normalize.test.js)
- 导入与路径集成验证：[ingest-labelplus.test.mjs](../../scripts/test/ingest-labelplus.test.mjs)、[ocr.test.mjs](../../scripts/test/ocr.test.mjs)、[data.test.mjs](../../scripts/test/data.test.mjs)、[check-data.test.mjs](../../scripts/test/check-data.test.mjs)

## 延伸阅读

- 索引建库与查询消费：[检索与分块模块](search-db-and-chunkfetch.md)
- 关键术语定义：[术语表](../glossary.md)

证据状态：除特别标注外，本页基于当前源码已确认。
