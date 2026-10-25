# @gallery/core

[返回「页间 · Pagehaven」项目说明](../../README.md)

页间 · Pagehaven 的平台无关核心：`data/meta` 与 `data/text` 的 schema（zod）、LabelPlus 解析器、
台词归一化（`tn`）、检索库构建、分块摘要清单、取块层（探测 / 取块 / 校验 / 多源）。
发布清单的编排在 `scripts/lib/manifest.mjs`，不属于这个包。

**只用 Web 标准 API**（CLAUDE.md 铁律 1）：fetch / Request / Response / Web Crypto /
Web Streams / WebAssembly。不 import Node 内置模块，不引原生依赖，sqlite 一律 wasm 版
（官方 `@sqlite.org/sqlite-wasm`；sql.js 发行版没编 FTS5，见 ARCHITECTURE 决策记录）。
`npm run check` 会扫 `src/` 拦下 `node:` 导入。测试在 `test/`，跑在 Node 上，不受此限。
