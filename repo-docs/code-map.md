# 页间 · Pagehaven 代码地图

先读[主流程的输入与交接](walkthroughs/one-real-run.md)，再按责任定位修改。本页只覆盖已声明主流程，不把目录出现过当作完整模块调查。

| 路径 | 职责 | 关键代码 | 与主流程的关系 |
| --- | --- | --- | --- |
| `scripts/` | 串联配置、清单、库、页面、索引与 sitemap | `scripts/build-site.mjs` | 根 package 的 build 顺序 |
| `scripts/lib/` | 加载内容并定义跨步骤清单契约 | `scripts/lib/manifest.mjs` | 清单、建库与站点步骤共享 |
| `packages/core/src/db/` | 构造浏览器可用检索库与分块描述 | `packages/core/src/db/build.js` | build:db 的库构造入口 |
| `packages/site/src/pages/` | 将生成内容映射为静态页面 | `packages/site/src/pages/index.astro` | build:site 调用 Astro |
| `packages/platform/src/` | 集中验证配置并生成托管平台文件 | `packages/platform/src/site-config.js` | build:config 之后进入站点输出 |

## `scripts/`

串联配置、清单、库、页面、索引与 sitemap。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/build-site.mjs) | 串联配置、清单、库、页面、索引与 sitemap | `站点步骤；build-manifest.mjs / build-db.mjs` | 根 package 的 build 顺序 |

相关验证：`scripts/test/site-build.test.mjs`。本轮只检查可读证据，业务测试没有执行。

## `scripts/lib/`

加载内容并定义跨步骤清单契约。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../scripts/lib/manifest.mjs) | 加载内容并定义跨步骤清单契约 | `buildManifest / galleryFingerprint` | 清单、建库与站点步骤共享 |

相关验证：`scripts/test/build-manifest.test.mjs`。本轮只检查可读证据，业务测试没有执行。

## `packages/core/src/db/`

构造浏览器可用检索库与分块描述。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../packages/core/src/db/build.js) | 构造浏览器可用检索库与分块描述 | `buildGalleryDb / openGalleryDb` | build:db 的库构造入口 |

相关验证：`scripts/test/build-db.test.mjs`。本轮只检查可读证据，业务测试没有执行。

## `packages/site/src/pages/`

将生成内容映射为静态页面。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../packages/site/src/pages/index.astro) | 将生成内容映射为静态页面 | `首页与动态章节路由` | build:site 调用 Astro |

相关验证：`scripts/test/site-build.test.mjs`。本轮只检查可读证据，业务测试没有执行。

## `packages/platform/src/`

集中验证配置并生成托管平台文件。范围仅为下表入口及主流程直接使用的契约，其余文件没有逐一审核。

| 重要代码 | 功能 | 关键符号 | 调用方 / 使用方 |
| --- | --- | --- | --- |
| [职责入口](../packages/platform/src/site-config.js) | 集中验证配置并生成托管平台文件 | `站点配置契约` | build:config 之后进入站点输出 |

相关验证：`packages/platform/test/site-config.test.js`。本轮只检查可读证据，业务测试没有执行。

## 覆盖范围

覆盖构建命令编排、清单与检索库交接、站点生成和预算守卫；源码地图只列这条路径涉及的文件。浏览器阅读偏好、备份恢复、在线检索细节、OCR 导入与三平台真实部署未展开。未提交的阅读器及外观变更保持原样，不作为已发布事实。

生成物、依赖安装目录、临时日志及第三方供应商源码不作为本次第一方模块地图。修改范围外机制前应重新调查，不能从本页推断兼容性。

证据状态：除特别标注外，本页基于当前源码已确认。
