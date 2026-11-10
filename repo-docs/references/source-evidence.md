# 页间 · Pagehaven 源码证据

这是调查台账：解释主流程的依据与边界，不能替代运行日志。最近同步锚点为 `0c9d890ca006f87a8ff5a6c0c92a982646488326`；2026-11-02 的四平台适配说明另包含当前未提交工作树，不等于已交付或已部署版本。

## Evidence Traversal Log

| Pass | Purpose | Inspected evidence | What changed in the model |
| --- | --- | --- | --- |
| Pass 1 | 建立输入、状态和输出路径 | `scripts/build-manifest.mjs`, `scripts/build-db.mjs`, `scripts/build-site.mjs`；根 README、package 或构建入口、Agent 规则 | 固定 walkthrough 的代表性行为，并列出交接位置。 |
| Pass 2（初次建档） | 反查失败与遗漏依赖 | `scripts/test/site-build.test.mjs`, `scripts/test/build-manifest.test.mjs`, `scripts/test/build-db.test.mjs`；配置、已有文档与范围内目录 | 反查空内容、清单版本/指纹不一致、无凭据图片核对和平台配置关闭路径；检查真实构建测试的生成目录副作用，初次建档时未运行该测试。 |
| Pass 1（2026-11-02） | 跟进四平台构建与部署交接 | `packages/platform/src/targets.js`、`packages/platform/src/generators/deploy.js`、`scripts/lib/release.mjs` | `all` 是四个主要目标，旧 Pages 独立保留；部署控制模板不进入公开产物。 |
| Pass 2（2026-11-02） | 反查容量、预览与上线确认 | `scripts/lib/deploy-budget.mjs`、`scripts/lib/deploy-proof.mjs`、`scripts/lib/deploy-ready.mjs`、`scripts/deploy.mjs`、`scripts/check.mjs` | 预留随机验证文件后检查预算；命令成功仍须读回本次目标的证明；ESA staging 请求与连接器同包；多目标失败不承诺跨平台回滚。 |
| 接线复核（2026-11-02） | 核对新增场景开关与原有偏好、配色接口的交互 | `packages/site/src/lib/day-night-control.js`、`packages/site/src/lib/color-scheme.js`、`packages/site/src/lib/site-appearance.js`、`packages/site/src/layouts/Base.astro` | 场景开关保留三态入口、订阅既有配色事件；按钮和纸页表面继续使用语义变量，避免覆盖可读对比色。 |

## 证据表

| Claim | Evidence | Confidence | Caveat | Used by |
| --- | --- | --- | --- | --- |
| 把配置和内容固定为一次构建输入 | [源码定位](../../scripts/build-manifest.mjs)：`buildManifest、verifyOnly、MISSING_FILE` | Confirmed | 初次调查为源码确认；最近运行结果见同步记录 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 给检索库绑定相同版本 | [源码定位](../../scripts/build-db.mjs)：`readManifest、resolveVersion、galleryFingerprint` | Confirmed | 初次调查为源码确认；最近运行结果见同步记录 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 每话生成一个可直接浏览的页面 | [源码定位](../../scripts/build-site.mjs)：`writeSiteGalleryJson、manifest.sourceSha256 检查、astro build` | Confirmed | 初次调查为源码确认；最近运行结果见同步记录 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 补齐静态托管需要的文件 | [源码定位](../../scripts/build-site.mjs)：`GENERATED_FILES、.nojekyll、metaRefresh` | Confirmed | 初次调查为源码确认；最近运行结果见同步记录 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 用预算与真实构建约束结果 | [源码定位](../../scripts/test/site-build.test.mjs)：`CONFIG_FILE / DATA_DIR / DIST_DIR / OUT_DIR、run` | Confirmed | 初次调查为源码确认；最近运行结果见同步记录 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| 公开响应配置与部署控制模板分离 | [生成物分类](../../packages/platform/src/index.js)：`GENERATED_FILES / DEPLOY_CONFIG_FILES`；[模板生成](../../packages/platform/src/generators/deploy.js) | Confirmed | 模板不含项目身份；实际部署配置临时注入，云端未验收 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| ESA 与四端共同发布拒绝超过 1,999 文件的业务产物 | [目标预算](../../packages/platform/src/targets.js)：`TARGET_CAPABILITIES`；[产物检查](../../scripts/lib/deploy-budget.mjs)：`validateDeploymentBudget` | Confirmed | 总量预留 1 文件和 4,096 字节供部署证明；文件数包含非章节资源，实际包仍受 CLI 限额约束 | [主流程](../walkthroughs/one-real-run.md) |
| 新目标须读回本次随机证明才生成成功回执，其他平台及旧证明均不匹配 | [随机证明](../../scripts/lib/deploy-proof.mjs)：`createDeploymentProof / matchesDeploymentProof`；[目标核对](../../scripts/lib/deploy-ready.mjs)：`waitForDeployment`；[部署入口](../../scripts/deploy.mjs)：`recordDeployment` | Confirmed | 证明只进入目标上传副本；源码和本地测试不证明真实云服务已上线 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |
| ESA staging 用同一 Undici 包的请求和连接器保留指定 IP、Host 与证书校验 | [预览连接](../../scripts/lib/deploy-ready.mjs)：`createStagingVerifier` | Confirmed | 账户的测试 IP、证书和云端连通性仍需真实预览验证 | [主流程](../walkthroughs/one-real-run.md) |
| 新目标同样禁止 push 自动部署 | [流水线守卫](../../scripts/lib/pipeline-policy.mjs)：`hasDeploymentCommand` | Confirmed | 只允许现有手动发布入口，未实际触发远端流水线 | [代码地图](../code-map.md) |
| 文档构建与搜索产物通过现有测试入口验证，GitHub 检查不能跳过文档安装和审计，文档发布仅手动触发 | [文档集成测试](../../scripts/test/docs-site.test.mjs)；[真实工作流回归](../../scripts/test/docs-workflow.test.mjs) | Confirmed | 本地回归读取实际 YAML，核对触发入口与失败阻断；联网审计由 CI 独立执行，不据此宣称云端部署验收 | [阅读与验证入口](../README.md)、[代码地图](../code-map.md) |
| 开发模式重建双语索引并更换浏览器缓存版本 | [启动器](../../scripts/docs-dev.mjs)：`startDocsDev`；[刷新插件](../../docs-site/.vitepress/guide-search-refresh.mjs)：`guideSearchRefresh`；[真实配置回归](../../scripts/test/docs-dev.test.mjs) | Confirmed | 保存 Markdown 会重启并刷新整页，搜索框关闭；生产构建不启用插件 | [阅读与验证入口](../README.md)、[代码地图](../code-map.md) |
| 昼夜场景开关与三态选择共用原有配色状态，页面外观继续使用语义变量 | [配色接线](../../packages/site/src/lib/day-night-control.js)：`mountDayNightControl`；[偏好状态](../../packages/site/src/lib/color-scheme.js)：`initializeColorScheme`；[布局](../../packages/site/src/layouts/Base.astro) | Confirmed | 仅覆盖配色接线；实际测试与浏览器验证结果另记同步记录，不扩大为所有阅读偏好已验收 | [代码地图](../code-map.md) |
| pnpm 部署运行器区分 JavaScript 与原生入口，并使用 dlx 的显式包与命令契约 | [命令计划](../../scripts/lib/deploy-plan.mjs)：`pnpmArgs`；[运行器](../../scripts/lib/pnpm-runner.mjs)：`resolvePnpmCommand`；[真实进程回归](../../scripts/test/pnpm-runner.test.mjs) | Confirmed | 本地包执行、CLI 版本检查和打包空跑不代替云端预览验收 | [主流程](../walkthroughs/one-real-run.md)、[代码地图](../code-map.md) |

## 反证与后续问题

工作区安装边界由 [pnpm 工作区配置](../../pnpm-workspace.yaml)、各包依赖声明和[锁文件回归](../../scripts/test/workspace.test.mjs)共同确认。旧本机依赖目录中的链接不证明干净安装可用；实际冻结安装和完整验证记录另见同步记录。

反证检查（Falsifying check）：若不匹配的内容仍能进入已绑定数据库的页面，或关闭平台配置后站点依赖函数才能阅读，当前静态构建模型需要修订。

下一位读者可能问（Next reader question）：浏览器如何按块读取检索库？packages/search 与 core/chunkfetch 暂缓展开；总体约束见原架构文档。

## 范围与未验证事项

覆盖构建命令编排、清单与检索库交接、站点生成、目标预算及部署回执边界；另记录配色控件与主题变量的兼容接线。其余浏览器阅读偏好、备份恢复、在线检索细节、OCR 导入与平台真实部署验收未展开。当前工作区实现不等于已发布版本。

表中的源码确认描述初次调查依据，不代表后续测试结果。各轮实际执行记录见[同步记录](../change-log.md)；完整构建与集成测试可能写入共享生成目录，执行前需保护已有工作。平台适配仍须另做真实预览部署。

本轮文档结构校验与站点构建结果记在[同步记录](../change-log.md)。源码链接在仓库阅读时指向真实文件；源码指南与 `docs-site/` 内的双语官网文档已独立维护，当前站点配置不再包含本指南，也不自动复制仓库源码。
