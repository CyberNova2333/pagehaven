# data/raw —— 翻译产物的原始稿

[返回「页间 · Pagehaven」项目说明](../../README.md)

`data/text` 是生成物，不手改；这里放它的**来源**：

```
data/raw/labelplus/<series>/<issue>/<chapter>.txt     LabelPlus 翻译稿（版本 1,0）
data/raw/ocr/<series>/<issue>/<chapter>.json          人工校对后的 OCR 稿
```

路径就是这一话的 key（与 `data/meta/<series>.yaml` 里的 id 对应，也与
`data/text/<series>/<issue>/<chapter>.json` 同形）。在手机上交稿 = 用 GitHub 网页
把 LabelPlus 导出的 txt 传到这个位置，然后在 GitHub Actions 运行「发布」工作流，`chapters` 填
`<series>/<issue>/<chapter>`（多话逗号分隔）。扩展名 `.TXT` 也认；`data/raw/labelplus/` 下除 README
与点文件之外的其它文件会被提示「不是 .txt」——不是稿就删掉。
同一话同时有多份仅扩展名大小写不同的稿时，全部列为冲突，不会自动挑一份导入；请只保留一份。

## ingest 做什么

`pnpm run ingest:labelplus`（发布流水线里由 `chapters` 非空时触发）：

- 解析稿 → 每个标签一个框（LabelPlus 的标签是点，`w=h=0`），`t` 原文、`tn` 归一化；
- 与 `data/meta` 核对：稿里页码超出 meta 页数 → **错误**；meta 里有页而稿里没有 →
  提示（没台词的页很常见）；meta 里没有这一话 → **错误**（先补 meta）；
- 写 `data/text/<series>/<issue>/<chapter>.json`，内容没变不重写；
- 所有错误列全再以非零退出；**提示（⚠）不影响退出码**。

导入前可在 Codespaces 运行 `pnpm run ingest:labelplus -- --dry-run`，列出将新增、更新、
保持不变的章节及全部诊断，不创建目录、不写文件。预览沿用下面的环境变量；通过后去掉
`--dry-run` 才执行导入。普通导入逐章处理，某章失败时其他有效章节仍会写入，最终以非零
退出；需要先核对整批问题时请先预览。`--help` 显示用法，未知参数会在导入前报错。

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

## 没有翻译稿时：可选 OCR 校对流程

OCR 只补缺稿，**不会把未经校对的识别结果自动变成台词**。它使用可选的 Tesseract CLI，
默认识别简体中文与英文（`chi_sim+eng`），采用稀疏文字模式。漫画中的手写字、竖排、特殊字体、
阅读顺序与气泡边界仍可能识别错误；输出只能当草稿。已有 `data/text` 的章节会跳过，不覆盖。

1. 在 GitHub Actions 手动发布工作流开启 OCR，并在 `chapters` 中明确填写少量章节；或在 Codespaces 中运行下列命令。
   OCR 不允许省略 `CHAPTERS`，不会隐式识别全库。Codespaces 若尚无引擎，可先安装
   `tesseract-ocr`、`tesseract-ocr-chi-sim`、`tesseract-ocr-eng` 软件包；普通构建不需要它们。

   ```bash
   CHAPTERS=sample/v/c pnpm run ingest:ocr
   ```

2. 校对产物在 `out/ocr-review/`，通过工作流工件下载取得（以发布版本命名的压缩包）。每话包含：

   ```text
   <series>/<issue>/<chapter>.json          待校对的结构化台词
   <series>/<issue>/<chapter>.html          框编号、页图与识别文字的对照预览
   <series>/<issue>/<chapter>.images/       预览使用的页图
   ```

   目录根部的 `report.json` 与 `README.txt` 记录本次结果；所选章节全部已有文本时仍会生成报告，
   明确说明本次没有新草稿。个别章节失败时报告会列出错误，成功章节的草稿会保留。

   解压时保持相对路径；可在 Codespaces 预览 HTML、用手机网页编辑 JSON。核对并修正 `t`、
   框的 `x/y/w/h`（0–1 比例）、漏字、漏框和阅读顺序；`i` 必须在同一页内唯一。
   保留每一页，空白页写 `boxes: []`。`tn` 不必手算，接受时会根据修改后的 `t` 重算。
   已存在的待校对 JSON 会保留，避免重跑 OCR 覆盖正在校对的内容。

3. 校对完成后，把 JSON 放入 `data/raw/ocr/<series>/<issue>/<chapter>.json`，再明确接受：

   ```bash
   CHAPTERS=sample/v/c pnpm run ingest:ocr -- --accept-reviewed
   ```

   此步骤不需要 OCR 引擎或网络，校验 schema、章节、页码和坐标后才写 `data/text`，仍不覆盖已有文本。
   `out/ocr-review` 中即使有草稿也不会被这一步自动采用。随后走正常检查与手动发布流程。

图片只从配置的图片来源读取；单图上限 20 MiB、每来源下载时限 20 秒，失败会尝试下一来源，
并核对图片内容摘要及图像尺寸。单页 OCR 时限 120 秒。空选择、缺引擎/语言包、下载失败、
无效 TSV 都会报告失败；有效空白页会明确提示人工核对。默认模式的任何草稿均不纳入文字层或检索。
