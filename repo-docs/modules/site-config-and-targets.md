# 配置与目标模块

本模块统一校验 `site.config.yaml`，注册静态托管目标与容量上限，并负责平台文件同步生成与交互式站点初始化/外观定制。

## 配置契约与目标能力矩阵

[站点配置校验](../../packages/platform/src/site-config.js) 使用 Zod schema 强制约束 `site.config.yaml` 各节点（`site`、`appearance`、`images`、`db`、`search`、`features`、`budgets`、`headers`、`redirects`、`seo`、`deploy`），确保 `db.page_size` 与 `search.request_chunk_size` 保持 2 的幂范围与对齐规则，同时拒绝不安全对象前缀与占位格式越界。

[目标注册表](../../packages/platform/src/targets.js) 区分五种静态托管目标与四端默认发布组：
- `DEPLOY_TARGETS`：`cloudflare`、`edgeone`、`github`、`workers`、`esa`；
- `DEFAULT_RELEASE_TARGETS`（`--target all`）：`edgeone`、`esa`、`github`、`workers`（旧 `cloudflare` Pages 独立保留但不进入 `all`）；
- `TARGET_CAPABILITIES`：显式标记 `esa` 的 2,000 文件 / `1,024,000,000` B 上限（含 1 证明文件）、`workers` 与 `cloudflare` 的 18,000 守卫、`github` 的 `1,000,000,000` B 总额限制及 `supportsPreview: false`。

## 公开生成物与部署控制模板分离

[平台包入口](../../packages/platform/src/index.js) 将生成物分为两类：
- **`GENERATED_FILES`**（受 `features.platform_config` 控制拷贝进 `dist/`）：`_headers`、`_redirects`、`edgeone.json`；
- **`DEPLOY_CONFIG_FILES`**（写回 `packages/platform/generated/` 供部署脚本读取，**绝不进入 `dist/`**）：`wrangler.jsonc`、`esa.jsonc`。

Workers 与 ESA 项目名共用 [部署名称校验](../../packages/platform/src/deploy-name.js) 中的 `isDeploymentName`，拒绝首尾连字符与非法前缀；[静态模板渲染](../../packages/platform/src/generators/deploy.js) 输出纯静态资源目录与 404 规则，不添加任何函数入口。

| 输入或状态 | 预期动作与结果 |
| --- | --- |
| `site.config.yaml` 与 `packages/platform/generated/` 不一致 | `pnpm run check`（`build:config` 同步校验）明确报错并退出非零 |
| `features.platform_config: false` | 不复制 `_headers`/`_redirects`/`edgeone.json` 进 `dist/`，站点保持纯静态基线 |
| `init-site` 同时传入 `--write` 与 `--dry-run`，或存在无法安全保留的 YAML 别名 | [初始化模块](../../scripts/lib/init-site.mjs) `parseInitArgs` / `planInit` 立即拒绝写入，避免破坏未选配置或注释 |

## 本地初始化与可视化自定义入口

- **命令行初始化**：[配置初始化脚本](../../scripts/init-site.mjs) 与 [规划逻辑](../../scripts/lib/init-site.mjs) 支持中英文双语交互或命令行参数批量编辑 `site.config.yaml`，保留原有注释并用安全临时文件写入，同时检查生产域名是否仍为 `example.org`。
- **浏览器配置器**：[站点自定义工具](../../scripts/customize.mjs) 启动绑定每次进程随机 64 位 hex token 的本地 HTTP 服务（默认 `127.0.0.1:4318`，Codespaces 下支持 `0.0.0.0`），调整标题、Logo、主题（`paper`/`ocean`/`plum`）、主色与开关并将原 YAML 备份到 `out/customize/`。

## 验证钩子

- 单元测试：[配置 schema 测试](../../packages/platform/test/site-config.test.js)、[模板生成测试](../../packages/platform/test/deployment-config.test.js)、[部署名测试](../../packages/platform/test/deploy-name.test.js)
- 脚本级集成验证：[初始化测试](../../scripts/test/init-site.test.mjs)、[自定义工具测试](../../scripts/test/customize.test.mjs)，以及全局门禁 `pnpm run check` 中的配置同步检查

## 延伸阅读

- 下游数据与归一化约束：[数据模型与归一化模块](data-model-and-normalization.md)
- 上线预算与证明闭环：[发布流水线与部署证明模块](release-pipeline-and-proofs.md)

证据状态：除特别标注外，本页基于当前源码已确认。
