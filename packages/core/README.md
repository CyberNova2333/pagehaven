# @gallery/core

平台无关的核心：`data/meta` 与 `data/text` 的 schema（zod）、LabelPlus 解析器、台词归一化
（`tn`）、manifest 生成、检索库构建、取块层（探测 / 取块 / 校验 / 多源）。

**只用 Web 标准 API**（CLAUDE.md 铁律 1）：fetch / Request / Response / Web Crypto /
Web Streams / WebAssembly。不 import Node 内置模块，不引原生依赖，sqlite 一律 sql.js。
`npm run check` 会扫 `src/` 拦下 `node:` 导入。测试在 `test/`，跑在 Node 上，不受此限。
