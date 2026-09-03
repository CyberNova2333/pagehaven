# data/raw —— 翻译产物的原始稿

`data/text` 是生成物，不手改；这里放它的**来源**。目前只有一种：

```
data/raw/labelplus/<series>/<issue>/<chapter>.txt     LabelPlus 翻译稿（版本 1,0）
```

路径就是这一话的 key（与 `data/meta/<series>.yaml` 里的 id 对应，也与
`data/text/<series>/<issue>/<chapter>.json` 同形）。在手机上交稿 = 用 GitHub 网页
把 LabelPlus 导出的 txt 传到这个位置，然后跑 `release.yml`，`chapters` 填
`<series>/<issue>/<chapter>`（多话逗号分隔）。扩展名 `.TXT` 也认；这个目录下除 README
与点文件之外的其它文件会被提示「不是 .txt」——不是稿就删掉。

## ingest 做什么

`npm run ingest:labelplus`（release.yml 里由 `chapters` 非空时触发）：

- 解析稿 → 每个标签一个框（LabelPlus 的标签是点，`w=h=0`），`t` 原文、`tn` 归一化；
- 与 `data/meta` 核对：稿里页码超出 meta 页数 → **错误**；meta 里有页而稿里没有 →
  提示（没台词的页很常见）；meta 里没有这一话 → **错误**（先补 meta）；
- 写 `data/text/<series>/<issue>/<chapter>.json`，内容没变不重写；
- 所有错误列全再以非零退出；**提示（⚠）不影响退出码**。

`chapters` 里列了、却没有稿的话：meta 里有这一话 → 只提示并跳过（这正是 `ocr`
输入要补的话，ingest:ocr 在后面拿同一份 `chapters` 跑）；meta 里也没有 → 错误，
多半是拼错了。

解析器对「像分隔符但不完全匹配」的行（例如逗号后多了空格）与「文件块头和第一个标签之间」
的行都会提示行号与内容：前者按台词保留、后者丢弃，行为不变，但真实导出稍有出入时台词
会无声消失，所以一定要在日志里看得见。看到这类提示就去核对那一行。

环境变量：`CHAPTERS`（限定处理哪些，空 = 全部有稿的话）；`LABELPLUS_PAGES` 选页码
策略：`auto`（默认）、`number`、`sequence`。

## 页码从哪来

稿里每个文件块的**文件名**决定它是第几页：

- 文件名全都带数字 → 取第一段数字（`001.jpg` → 第 1 页，`page_012.png` → 12）。
  **数字必须等于 meta 里的页码 `n`（从 1 起）**；
- 有任何一个文件名不带数字 → 整份稿按文件块出现顺序 1..N；
- 图片从 `000` 起编号、或封面单独叫 `cover.jpg` 之类，ingest 会报页码 0 或页数
  对不上——用 `LABELPLUS_PAGES=sequence` 按顺序，前提是稿里的文件顺序 = 页顺序。

解析器不猜：对不上就报错，宁可响也不哑。
