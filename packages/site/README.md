# @gallery/site

Astro 静态站：作品 / 期 / 话页面、阅读器（每话一个 HTML，`#p12` 深链，文字层内嵌）、
搜索页。产物在仓库根 `dist/`。

只用 Web 标准 API（CLAUDE.md 铁律 1）：不 import Node 内置模块。构建期需要的配置由
`npm run build:config` 生成到 `src/generated/`（不入库），页面只 import 那份 JSON。

```bash
npm run build:config   # 先生成 src/generated/site-config.json
npm run build:site     # = astro build + 平台生成物 + GitHub Pages 基线文件
```
