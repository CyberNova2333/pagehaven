# data/text —— 台词（画面文字）层

每话一个文件：`data/text/<series>/<issue>/<chapter>.json`，由 `npm run ingest:labelplus`
（首选）或 `ingest:ocr`（只补缺稿）生成，不手改。

```json
{ "chapter": "sample/vol03/c012",
  "pages": [{ "n": 1, "boxes": [
    { "i": 0, "x": 0.12, "y": 0.08, "w": 0.20, "h": 0.15, "t": "原台词", "tn": "归一化文本" } ] }] }
```

来源是 `data/raw/labelplus/<series>/<issue>/<chapter>.txt`（见 [`../raw/README.md`](../raw/README.md)）。

坐标归一化到 0–1，与分辨率无关；`w`/`h` 为 0 表示 LabelPlus 的点标签。`tn` = NFKC →
去空白、标点、符号、控制 / 格式 / 私用字符与变体选择符 → 再 NFKC → OpenCC 繁→简 → 小写，
只用于检索；`t` 只用于展示。schema 与归一化实现在 `@gallery/core`（`normalizeText`）。
