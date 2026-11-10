# 页间 · Pagehaven 代码地图

先读[主流程的输入与交接](walkthroughs/one-real-run.md)，再按责任定位修改。本页只覆盖已声明主流程，不把目录出现过当作完整模块调查。

| 路径 | 职责 | 关键代码 | 与主流程的关系 |
| --- | --- | --- | --- |
| `scripts/` | 串联构建、检查与目标部署 | `scripts/build-site.mjs`、`scripts/deploy.mjs` | 根 package 的构建与部署命令 |
| `scripts/lib/` | 加载内容，核对清单、预算和部署回执 | `scripts/lib/manifest.mjs`、`scripts/lib/release.mjs` | 构建与发布交接 |
| `packages/core/src/` | 统一进入 CDN URL 的安全对象路径契约 | `packages/core/src/object-path.js` | 配置、发布和浏览器检索共享；仅覆盖此辅助文件 |
| `packages/core/src/db/` | 构造浏览器可用检索库与分块描述 | `packages/core/src/db/build.js` | build:db 的库构造入口 |
| `packages/site/` | 生成静态页面，接入布局、配色状态及公开场景脚本 | `packages/site/src/pages/index.astro`、`packages/site/src/layouts/Base.astro`、`packages/site/src/lib/day-night-control.js`、`packages/site/public/day-night-switch.js` | 仅覆盖页面入口及配色接线；其余页面行为与公开资源未展开 |
| `packages/platform/src/` | 集中验证配置、声明目标并生成平台文件 | `packages/platform/src/site-config.js`、`packages/platform/src/targets.js` | 构建响应配置及部署控制模板 |

## `scripts/`

串联配置、清单、库、页面、索引、sitemap 和目标部署。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/build-site.mjs) | 串联配置、清单、库、页面、索引与 sitemap | `站点步骤；build-manifest.mjs / build-db.mjs` | 根 package 的 build 顺序 |
| [部署入口](../scripts/deploy.mjs) | 检查产物，创建临时部署配置，执行 CLI 并记录成功回执 | `deploymentInput / recordDeployment` | 手动发布流水线 |
| [验收与发布检查](../scripts/check.mjs) | 检查生成配置、静态产物及所选目标预算，禁止自动发布 | `inspectDeploymentFiles / validateDeploymentBudget` | 本地检查与 GitHub Actions 发布前检查 |

相关验证：`scripts/test/site-build.test.mjs`、`scripts/test/deploy-plan.test.mjs`、`scripts/test/deploy-static.test.mjs`。实际执行结果见[同步记录](change-log.md)。

## `scripts/lib/`

加载内容并定义跨步骤清单、部署预算和版本回执契约。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/lib/manifest.mjs) | 加载内容并定义跨步骤清单契约 | `buildManifest / galleryFingerprint` | 清单、建库与站点步骤共享 |
| [README 章节链接校验](../scripts/lib/readme-links.mjs) | 校验双语导航是否指向标题生成的有效锚点 | `checkReadmeLinks` | `scripts/check.mjs`；回归见 `scripts/test/readme-links.test.mjs` |
| [静态跳转输出边界](../scripts/lib/static-output.mjs) | 预检重定向的规范路径及输出根边界，转义跳转页属性 | `redirectOutputPaths / metaRefresh` | `scripts/build-site.mjs`；回归见 `scripts/test/static-output.test.mjs` |
| [部署计划](../scripts/lib/deploy-plan.mjs) | 将目标、环境和 secrets 变成 CLI 参数，隔离预览名称与地址 | `planDeployCommand` | 部署入口 |
| [部署工具启动](../scripts/lib/pnpm-runner.mjs) | 解析 pnpm 的 JavaScript 或原生入口，保持参数数组，不经 shell 拼接；缺失时明确失败 | `resolvePnpmCommand` | 部署入口；回归见 `scripts/test/pnpm-runner.test.mjs` |
| [平台预算](../scripts/lib/deploy-budget.mjs) | 遍历普通文件，为新目标预留部署证明容量，拒绝链接、保留路径及超预算产物 | `inspectDeploymentFiles / validateDeploymentBudget` | 检查入口与部署入口共用 |
| [部署随机证明](../scripts/lib/deploy-proof.mjs) | 生成只交给本次目标的随机验证文件，绑定目标、版本、指纹和环境 | `createDeploymentProof / deploymentProofFile / matchesDeploymentProof` | 临时上传副本与线上核对 |
| [目标上线核对](../scripts/lib/deploy-ready.mjs) | 有界重试匹配本次随机证明；ESA staging 使用同包请求与连接器覆盖 DNS，保留证书校验 | `deploymentRoot / waitForDeployment / createStagingVerifier` | Workers 与 ESA 部署后确认 |
| [生产指针启用](../scripts/lib/release.mjs) | 展开发布目标并核对全部回执，以条件写入启用版本 | `releasePlan / activateRelease` | 发布流水线的准备与启用步骤 |
| [流水线守卫](../scripts/lib/pipeline-policy.mjs) | 检出自动部署命令，并保证自动、手动检查按序安装和审计文档依赖后再测试 | `hasDeploymentCommand / checkDocumentationPipelines` | 检查入口；回归见 `scripts/test/pipeline-policy.test.mjs` |

相关验证：`scripts/test/build-manifest.test.mjs`、`scripts/test/deploy-plan.test.mjs`、`scripts/test/deploy-static.test.mjs`、`scripts/test/deploy-transport.test.mjs`、`scripts/test/release.test.mjs`。部署连接回归使用真实本地 HTTP 请求；实际执行结果见[同步记录](change-log.md)。

## `packages/core/src/`

配置、上传计划和检索加载器共用安全对象路径，不让各层接受不同的目录语法。本节只覆盖这一共享辅助文件，不扩大到其余 core 模块。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [共享对象路径校验](../packages/core/src/object-path.js) | 约束无需 URL 转义的相对对象 key 与目录前缀 | `isSafeObjectPrefix / isSafeObjectKey` | 平台配置、上传计划、浏览器检索加载器 |

相关验证 `scripts/test/object-prefix.test.mjs` 使用真实 SQLite，依次检查配置、发布计划、摘要及浏览器查询。

## `packages/core/src/db/`

构造浏览器可用检索库与分块描述。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../packages/core/src/db/build.js) | 构造浏览器可用检索库与分块描述 | `buildGalleryDb / openGalleryDb` | build:db 的库构造入口 |

相关验证：`scripts/test/build-db.test.mjs`。实际执行结果见[同步记录](change-log.md)。

## `packages/site/`

页面入口把生成内容映射为静态 HTML，共享布局接入主题变量和浏览器配色控件。读者选择“跟随系统”时，页面和昼夜场景一起跟随系统外观；点击场景开关改成固定的浅色或深色后，仍可从旁边的三态选项恢复跟随系统。两种控件共用原有偏好状态，不各自读写存储。场景脚本没有载入时，三态选项仍可使用。

纸页装饰从既有表面变量取色，按钮从主色与对比色变量取色，避免新增样式改掉维护者的配色配置。本节仅覆盖下列页面入口及配色接线，其余页面行为与公开资源没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [页面入口](../packages/site/src/pages/index.astro) | 将生成内容映射为静态页面 | `首页与动态章节路由` | build:site 调用 Astro |
| [共享布局](../packages/site/src/layouts/Base.astro) | 挂载控件，以 `--surface`、`--accent`、`--on-accent` 等变量绘制页面 | `mountDayNightControl` | 构建输出的各页面 |
| [偏好状态](../packages/site/src/lib/color-scheme.js) | 恢复三态选择、持久化及系统与跨标签同步，通知解析后的配色 | `initializeColorScheme` | 页面首屏与两种配色控件 |
| [场景接线](../packages/site/src/lib/day-night-control.js) | 保留三态选择，把快捷操作交给原状态源并同步场景显示 | `mountDayNightControl` | 共享布局 |
| [语义配色](../packages/site/src/lib/site-appearance.js) | 从主题和主色计算表面、文字及按钮对比色 | `appearanceVariables` | 共享布局与维护者编辑器 |
| [场景组件](../packages/site/public/day-night-switch.js) | 昼夜外观、快捷切换和无障碍状态 | `DayNightSwitch.mount / apply / destroy` | 场景接线 |

相关验证：`scripts/test/site-build.test.mjs`、`packages/site/test/day-night-control.test.js`、`packages/site/test/color-scheme.test.js`、`packages/site/test/site-appearance.test.js`。实际执行结果见[同步记录](change-log.md)。

## `packages/platform/src/`

集中验证配置、声明部署目标及能力，生成可公开响应配置和独立部署控制模板。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../packages/platform/src/site-config.js) | 集中验证配置并生成托管平台文件 | `站点配置契约` | build:config 之后进入站点输出 |
| [目标注册](../packages/platform/src/targets.js) | 区分旧 Pages 与 Workers，定义 `all` 四端集合及容量 | `DEPLOY_TARGETS / DEFAULT_RELEASE_TARGETS / TARGET_CAPABILITIES` | 初始化、发布计划、预算检查 |
| [部署名称约束](../packages/platform/src/deploy-name.js) | 共用 Workers 与 ESA 名称校验，拒绝 Workers 名称首尾连字符 | `isDeploymentName` | 部署计划与配置生成器 |
| [生成物分类](../packages/platform/src/index.js) | 区分公开响应配置和不得进入 `dist` 的部署控制模板 | `GENERATED_FILES / DEPLOY_CONFIG_FILES / generateAll` | 配置生成、同步检查与站点构建 |
| [部署模板生成](../packages/platform/src/generators/deploy.js) | 生成静态资源目录及 404 规则，不引入函数入口 | `renderWorkersDeployConfig / renderEsaDeployConfig` | 配置生成与部署临时目录 |

相关验证：`packages/platform/test/site-config.test.js`、`packages/platform/test/deployment-config.test.js`。实际执行结果见[同步记录](change-log.md)。

## 工作区安装

[工作区配置](../pnpm-workspace.yaml)登记业务包与依赖覆盖，根和各包的 `package.json` 声明本地引用。[工作区回归](../scripts/test/workspace.test.mjs)核对实际声明与业务锁文件中的本地链接，防止仅凭旧依赖目录通过检查；[站点构建](../scripts/build-site.mjs)从站点包解析其 Astro 入口。

## 文档构建与开发搜索

[文档站集成测试](../scripts/test/docs-site.test.mjs)由 `pnpm test` 自动发现，也可通过 `pnpm run test:docs` 单独运行。它调用已安装的 VitePress，在系统临时目录构建当前双语官网文档，读取最终 HTML 校验页面与链接，再加载同次产物的 MiniSearch 索引执行真实查询。依赖缺失直接报安装命令，不跳过；不模拟浏览器交互，也不覆盖默认文档产物。GitHub Actions 的检查流水线负责独立依赖安装与联网审计，业务发布入口保持原有职责。

[开发启动器](../scripts/docs-dev.mjs)管理单个 VitePress 子进程；[刷新插件](../docs-site/.vitepress/guide-search-refresh.mjs)复用文件监听器，在 Markdown 增删改后请求串行重启，并为语言索引生成每次启动独立的缓存版本。插件只在开发服务运行，构建输出不含它。当前[站点配置](../docs-site/.vitepress/config.mts)负责双语路由及插件接线，官网内容已与源码指南分开维护。

[开发搜索回归](../scripts/test/docs-dev.test.mjs)复制真实站点配置，启动隔离服务，查询真实语言索引并模拟浏览器的长期缓存。覆盖尚未访问的引用正文、直接页面、中英文隔离、连续保存、页面增删与标题改名，以及关闭后释放端口；因此漏接插件或复用旧版本 URL 都会失败。

[工作流回归](../scripts/test/docs-workflow.test.mjs)读取实际 GitHub YAML，核对检查仅允许 main push 或手动触发，文档安装、审计和统一测试不能漏掉、跳过或吞错，并保证文档站仅手动发布且部署依赖构建产物。它由 `pnpm test` 自动发现，不触发云端发布。

## 覆盖范围

覆盖构建命令编排、清单与检索库交接、站点生成、目标预算及部署回执边界；另记录配色控件与主题变量的兼容接线。其余浏览器阅读偏好、备份恢复、在线检索细节、OCR 导入与平台真实部署验收未展开。当前工作区实现不等于已发布版本。

生成物、依赖安装目录、临时日志及第三方供应商源码不作为本次第一方模块地图。修改范围外机制前应重新调查，不能从本页推断兼容性。

证据状态：除特别标注外，本页基于当前源码已确认。
