# 页间 · Pagehaven 文档质量复核

本页用于审核 `repo-docs/` 在 Standard 模式下是否回答了维护者与新协作者的关键问题，并显式标明未覆盖风险。

## Reader Simulation

| 读者问题 | 从指南能得到的答案与去向 |
| --- | --- |
| **入口与输出路径**：数据从哪里进入，经哪些文件交接并输出什么？ | [一次真实主流程](../walkthroughs/one-real-run.md) 的代表性输入表与六步路径完整说明输入 YAML/JSON 到 `dist`、SQLite 与 R2 的输出交接。 |
| **核心难点**：为什么不能只跑单步构建更新个别页面？ | [发布流水线与部署证明模块](../modules/release-pipeline-and-proofs.md) 与 [主流程](../walkthroughs/one-real-run.md) 说明了 `sourceSha256`、`gallery.searchDb` 与 R2 指针原子启用如何协同杜绝半截上线。 |
| **运行阶段**：整个构建与上线流程分成哪几个阶段？ | 依次为：1) 配置与清单固定 → 2) 绑定版本的 SQLite 建库 → 3) 每话静态页与索引编译 → 4) 预算与检查门禁 → 5) R2 不可变上传 → 6) 多端随机证明核对与条件启用。 |
| **失败边界**：哪些异常会被拒绝或退避？ | 各模块页均列出代表性拒绝/降级输入：如 ESA 超 1,999 业务文件拒传、短于 2 字拒绝下载库、Comimi 在 `#p<n>b<i>` 或条漫退避、验证证明不匹配拒改生产指针。 |
| **如何验证**：修改不同目录后运行什么验证命令？ | [指南首页](../README.md) 与 [代码地图](../code-map.md) 标明了根构建、`check`、`pnpm test`、`test:docs` 与包内测试入口；各次实际命令结果记录在 [指南变更记录](../change-log.md)。 |
| **文本与检索一致性**：繁体、全角和康熙部首为何都能命中？ | [数据模型与归一化模块](../modules/data-model-and-normalization.md) 与 [检索与分块模块](../modules/search-db-and-chunkfetch.md) 解释了五步幂等 `normalizeText` 与 `MATCH`/`LIKE` 混合策略。 |
| **领域术语与概念**：不同模块里的专用名分别指什么？ | [术语表](../glossary.md) 统一定义核心概念、环境变量与约束上限。 |

## 可理解性与剩余风险

- **结构分层**：[指南首页](../README.md) 专注导航，[主流程](../walkthroughs/one-real-run.md) 建立行为模型，[代码地图](../code-map.md) 提供按包索引，5 篇模块说明各自独立拥有领域细节，[术语表](../glossary.md) 统一关键术语，无跨页大段复制。
- **反证检查（Falsifying check）**：若 `build:site` 允许未同步的 `manifest.sourceSha256` 写出产物，或关闭 `platform_config` 后核心浏览/搜索损坏，则文档核心结论即被推翻。
- **未解决后续问题**：按块检索已接入可选 Worker，真实 CDN 的 Range、CORS 与平台预览仍待线上验收。

证据状态：除特别标注外，本页基于当前源码已确认。
