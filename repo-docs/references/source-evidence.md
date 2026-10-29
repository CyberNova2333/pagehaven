# 页间 · Pagehaven 源码证据

这是调查台账：解释主流程的依据与边界，不能替代运行日志。源码锚点为 `727cb72578cd6152f67dcb33be578e2a2fe80e56`；本轮还读取了当前工作树，未提交内容不等于已交付版本。

## Evidence Traversal Log

| Pass | Purpose | Inspected evidence | What changed in the model |
| --- | --- | --- | --- |
| Pass 1 | 建立输入、状态和输出路径 | `scripts/build-manifest.mjs`, `scripts/build-db.mjs`, `scripts/build-site.mjs`；根 README、package 或构建入口、Agent 规则 | 固定 walkthrough 的代表性行为，并列出交接位置。 |
| Pass 2 | 反查失败与遗漏依赖 | `scripts/test/site-build.test.mjs`, `scripts/test/build-manifest.test.mjs`, `scripts/test/build-db.test.mjs`；配置、已有文档与范围内目录 | 反查空内容、清单版本/指纹不一致、无凭据图片核对和平台配置关闭路径；检查真实构建测试的生成目录副作用，确定本轮不运行该测试。 |

## 证据表

| Claim | Evidence | Confidence | Caveat | Used by |
| --- | --- | --- | --- | --- |
| 把配置和内容固定为一次构建输入 | [源码定位](../../scripts/build-manifest.mjs)：`buildManifest、verifyOnly、MISSING_FILE` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 给检索库绑定相同版本 | [源码定位](../../scripts/build-db.mjs)：`readManifest、resolveVersion、galleryFingerprint` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 每话生成一个可直接浏览的页面 | [源码定位](../../scripts/build-site.mjs)：`writeSiteGalleryJson、manifest.sourceSha256 检查、astro build` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 补齐静态托管需要的文件 | [源码定位](../../scripts/build-site.mjs)：`GENERATED_FILES、.nojekyll、metaRefresh` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 用预算与真实构建约束结果 | [源码定位](../../scripts/test/site-build.test.mjs)：`CONFIG_FILE / DATA_DIR / DIST_DIR / OUT_DIR、run` | Confirmed | 源码静态确认；本轮未运行业务路径 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |

## 反证与后续问题

反证检查（Falsifying check）：若不匹配的内容仍能进入已绑定数据库的页面，或关闭平台配置后站点依赖函数才能阅读，当前静态构建模型需要修订。

下一位读者可能问（Next reader question）：浏览器如何按块读取检索库？packages/search 与 core/chunkfetch 暂缓展开；总体约束见原架构文档。

## 范围与未验证事项

覆盖构建命令编排、清单与检索库交接、站点生成和预算守卫；源码地图只列这条路径涉及的文件。浏览器阅读偏好、备份恢复、在线检索细节、OCR 导入与三平台真实部署未展开。未提交的阅读器及外观变更保持原样，不作为已发布事实。

以上业务检查未执行；npm run build 和站点集成测试都可能写入共享生成目录，本轮只运行独立文档站构建。正式验收仍需 npm run check、npm test、npm run build，涉及平台适配时按根规则另做预览部署。

本轮文档结构校验与站点构建结果记在[同步记录](../change-log.md)。源码链接在仓库阅读时指向真实文件；独立站点只发布指南；文档目录之外的仓库源码链接在网页中显示为精确路径，源码不随站点打包。原始 Markdown 保留本地可核对链接。已有 VitePress 使用原文包含，正文只维护一份。
