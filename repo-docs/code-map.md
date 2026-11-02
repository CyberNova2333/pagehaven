# 页间 · Pagehaven 代码地图

先读[主流程的输入与交接](walkthroughs/one-real-run.md)，再按责任定位修改。本页只覆盖已声明主流程，不把目录出现过当作完整模块调查。

| 路径 | 职责 | 关键代码 | 与主流程的关系 |
| --- | --- | --- | --- |
| `scripts/` | 串联构建、检查与目标部署 | `scripts/build-site.mjs`、`scripts/deploy.mjs` | 根 package 的构建与部署命令 |
| `scripts/lib/` | 加载内容，核对清单、预算和部署回执 | `scripts/lib/manifest.mjs`、`scripts/lib/release.mjs` | 构建与发布交接 |
| `packages/core/src/` | 统一进入 CDN URL 的安全对象路径契约 | `packages/core/src/object-path.js` | 配置、发布和浏览器检索共享；仅覆盖此辅助文件 |
| `packages/core/src/db/` | 构造浏览器可用检索库与分块描述 | `packages/core/src/db/build.js` | build:db 的库构造入口 |
| `packages/site/src/pages/` | 将生成内容映射为静态页面 | `packages/site/src/pages/index.astro` | build:site 调用 Astro |
| `packages/platform/src/` | 集中验证配置、声明目标并生成平台文件 | `packages/platform/src/site-config.js`、`packages/platform/src/targets.js` | 构建响应配置及部署控制模板 |

## `scripts/`

串联配置、清单、库、页面、索引、sitemap 和目标部署。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/build-site.mjs) | 串联配置、清单、库、页面、索引与 sitemap | `站点步骤；build-manifest.mjs / build-db.mjs` | 根 package 的 build 顺序 |
| [部署入口](../scripts/deploy.mjs) | 检查产物，创建临时部署配置，执行 CLI 并记录成功回执 | `deploymentInput / recordDeployment` | 手动发布流水线 |
| [验收与发布检查](../scripts/check.mjs) | 检查生成配置、静态产物及所选目标预算，禁止自动发布 | `inspectDeploymentFiles / validateDeploymentBudget` | 本地检查与 CNB 发布前检查 |

相关验证：`scripts/test/site-build.test.mjs`、`scripts/test/deploy-plan.test.mjs`、`scripts/test/deploy-static.test.mjs`。实际执行结果见[同步记录](change-log.md)。

## `scripts/lib/`

加载内容并定义跨步骤清单、部署预算和版本回执契约。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/lib/manifest.mjs) | 加载内容并定义跨步骤清单契约 | `buildManifest / galleryFingerprint` | 清单、建库与站点步骤共享 |
| [README 章节链接校验](../scripts/lib/readme-links.mjs) | 校验双语导航是否指向标题生成的 CNB 锚点 | `checkReadmeLinks` | `scripts/check.mjs`；回归见 `scripts/test/readme-links.test.mjs` |
| [静态跳转输出边界](../scripts/lib/static-output.mjs) | 预检重定向的规范路径及输出根边界，转义跳转页属性 | `redirectOutputPaths / metaRefresh` | `scripts/build-site.mjs`；回归见 `scripts/test/static-output.test.mjs` |
| [部署计划](../scripts/lib/deploy-plan.mjs) | 将目标、环境和 secrets 变成 CLI 参数，隔离预览名称与地址 | `planDeployCommand` | 部署入口 |
| [平台预算](../scripts/lib/deploy-budget.mjs) | 遍历普通文件，为新目标预留部署证明容量，拒绝链接、保留路径及超预算产物 | `inspectDeploymentFiles / validateDeploymentBudget` | 检查入口与部署入口共用 |
| [部署随机证明](../scripts/lib/deploy-proof.mjs) | 生成只交给本次目标的随机验证文件，绑定目标、版本、指纹和环境 | `createDeploymentProof / deploymentProofFile / matchesDeploymentProof` | 临时上传副本与线上核对 |
| [目标上线核对](../scripts/lib/deploy-ready.mjs) | 有界重试匹配本次随机证明；ESA staging 使用同包请求与连接器覆盖 DNS，保留证书校验 | `deploymentRoot / waitForDeployment / createStagingVerifier` | Workers 与 ESA 部署后确认 |
| [生产指针启用](../scripts/lib/release.mjs) | 展开发布目标并核对全部回执，以条件写入启用版本 | `releasePlan / activateRelease` | 发布流水线的准备与启用步骤 |
| [自动发布守卫](../scripts/lib/pipeline-policy.mjs) | 检出部署命令，不依赖逐个平台名称的白名单 | `hasDeploymentCommand` | 检查入口；回归见 `scripts/test/pipeline-policy.test.mjs` |

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

## `packages/site/src/pages/`

将生成内容映射为静态页面。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../packages/site/src/pages/index.astro) | 将生成内容映射为静态页面 | `首页与动态章节路由` | build:site 调用 Astro |

相关验证：`scripts/test/site-build.test.mjs`。实际执行结果见[同步记录](change-log.md)。

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

## 覆盖范围

覆盖构建命令编排、清单与检索库交接、站点生成、目标预算及部署回执边界。浏览器阅读偏好、备份恢复、在线检索细节、OCR 导入与平台真实部署验收未展开。当前工作区实现不等于已发布版本。

生成物、依赖安装目录、临时日志及第三方供应商源码不作为本次第一方模块地图。修改范围外机制前应重新调查，不能从本页推断兼容性。

证据状态：除特别标注外，本页基于当前源码已确认。
