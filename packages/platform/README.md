# @gallery/platform

[返回「页间 · Pagehaven」项目说明](../../README.md)

页间 · Pagehaven 的平台绑定层：集中校验 `site.config.yaml`，声明部署目标与预算，生成静态响应配置及部署控制模板。
全是纯函数；读取产物、创建临时配置、执行 CLI 和确认上线的操作在 `scripts/`。

一次构建生成两类文件，只有第一类能进入公开静态产物：

| 生成物 | 用途 | 去向 |
| --- | --- | --- |
| `_headers`、`_redirects`、`edgeone.json` | 托管平台的可选响应规则 | `GENERATED_FILES` 声明；开启 `platform_config` 时复制到 `dist` |
| `wrangler.jsonc`、`esa.jsonc` | Workers Static Assets 与 ESA Pages 的部署控制模板 | `DEPLOY_CONFIG_FILES` 声明；留在 `packages/platform/generated/`，不放进 `dist` |

部署控制模板不含项目名。部署脚本在临时目录调用 `renderWorkersDeployConfig` 或
`renderEsaDeployConfig`，从 secrets 注入已校验名称和上传副本的绝对路径。计划与生成器共用
[部署名称校验](src/deploy-name.js)：Workers 名称必须是最多 63 字符的小写 DNS 标签，首尾不能是连字符。Workers 使用目录式 HTML
与真实 404，ESA 使用 `404Page` 且不重复安装、构建；两者均不生成函数入口。
`deploy.workers.compatibility_date` 由 YAML 控制；旧配置缺失新字段时采用兼容默认值。

[目标注册表](src/targets.js)中的 `DEPLOY_TARGETS` 保留 `cloudflare`（Cloudflare Pages），
新增 `workers` 和 `esa`。`DEFAULT_RELEASE_TARGETS` 定义 `all` 为 Makers、ESA、GitHub Pages、
Workers 四端。`TARGET_CAPABILITIES` 描述预览支持、部署验证和静态预算：ESA 上传总量最多
2,000 文件、1,024,000,000 字节；GitHub 站点总大小最多 1,000,000,000 字节。
官方限额未声明二进制单位，因此按十进制字节保守检查；其他仓库预算仍适用，实际部署包还须满足 CLI 限制。
Workers 与 ESA 每次部署都预留 1 文件和 4,096 字节给验证文件，默认业务产物上限分别为
17,999 和 1,999 文件；ESA 总大小也计入该字节预留。因此 2,000 文件的业务产物虽然满足
仓库基础预算，部署到 ESA 或 `all` 仍会在上传前被拒绝。

随机验证文件只写入本次目标的临时上传副本，绑定目标、版本、指纹、环境和随机值；
不会改动共享 `dist` 或归档。部署后必须读回同一文件，其他平台的共用发布标记不能替代它。
验证地址填写实际到达该目标的 HTTPS 根地址；地址还指向其他平台时会验证失败。

每一处平台绑定都必须有降级：验收基线是 GitHub Pages——没有响应头、没有重定向、没有函数。

`db.prefix` 与浏览器及发布计划共用 core 的对象路径契约：以 `/` 结尾，各段仅含 ASCII
字母、数字、下划线、连字符和点，不能有空段或独立的 `.`、`..`。不支持的前缀在构建前报错；
这项校验对所有目标相同，不依赖响应头、重定向或函数。

平台适配的本地测试不能代替真实预览部署。当前根路径契约不支持 GitHub 项目站子路径；
部署参数、secrets 和上线验证边界见[根 README](../../README.md#部署)。
