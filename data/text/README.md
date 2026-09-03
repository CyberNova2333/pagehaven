# data/text —— 台词（画面文字）层

每话一个文件：`data/text/<series>/<issue>/<chapter>.json`，由 `npm run ingest:labelplus`
（首选）或 `ingest:ocr`（只补缺稿）生成，不手改。

```json
{ "chapter": "sample/vol03/c012",
  "pages": [{ "n": 1, "boxes": [
    { "i": 0, "x": 0.12, "y": 0.08, "w": 0.20, "h": 0.15, "t": "原台词", "tn": "归一化文本" } ] }] }
```

坐标归一化到 0–1，与分辨率无关。`tn` = OpenCC 繁→简 + `normalize('NFKC')` + 去空白与标点，
只用于检索；`t` 只用于展示。schema 与归一化实现在 `@gallery/core`。
