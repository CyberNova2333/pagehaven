# 发布流水线与部署证明模块

本模块协调私有 R2 上传、多平台容量预算守卫、临时部署证明检验、原子指针启用以及 IndexNow 增量页面推送。

## 不可变上传与发布状态核对

1. **R2 发布 (`publish:r2`)**：[R2 发布入口](../../scripts/publish-r2.mjs) 与 [发布计划](../../scripts/lib/publish-plan.mjs) 读取 `OUT_DIR` 中的 `manifest.json`，仅上传新增 WebP 图片与带版本号的 SQLite 及分块摘要，随后写出不可变 `manifest-<version>.json` 并把线上当前指针另存为 `OUT_DIR` 下的 `manifest-previous.json` 供后续 SEO 差分。
2. **三阶段指针控制 (`release.mjs`)**：[发布守卫](../../scripts/lib/release.mjs) 中的 `releasePlan` 校验目标有效性，并在 `environment === 'production'` 且存在真实部署目标时拒绝 `example.org`、`localhost` 等占位域名；若 `environment === 'preview'` 且选了 `github` 或 `all`，立即在上传前拒绝。`prepareRelease` 记录线上清单的 `ETag` 与内容指纹到 `release-state.json`；`activateRelease` 在全部选定目标回执均一致匹配 `(version, fingerprint)` 后，才用 `If-Match`（首次用 `If-None-Match: *`）原子切换生产 `manifest.json`。

## 静态输出、预算检查与随机证明检验

- **静态输出边界**：[静态输出检验](../../scripts/lib/static-output.mjs)（`redirectOutputPaths` 与 `metaRefresh`）保证重定向源为有效站内路径且输出文件严禁逃逸 `DIST_DIR`，同时对生成跳转页的 `lang` 与 `url` 做 HTML 属性转义。
- **预算计算与预留**：[预算检查器](../../scripts/lib/deploy-budget.mjs) 遍历普通文件、拒绝符号链接与保留内部路径；对 `workers`（18,000）与 `esa`（2,000 文件 / `1,024,000,000` 字节）自动预留 1 个文件和 4,096 字节给本次部署证明，因此业务静态产物硬上限分别为 **17,999** 与 **1,999** 文件（`all` 需同时满足四端最严上限）。
- **命令拼装与安全执行器**：[部署计划](../../scripts/lib/deploy-plan.mjs) 为固定版本官方 CLI（`wrangler@4`、`edgeone@1`、`esa-cli@1.0.13`）生成参数数组；[pnpm 运行器](../../scripts/lib/pnpm-runner.mjs) 区分 JavaScript 入口与原生二进制，绝不把原生 pnpm 交给 Node 也不经 shell 拼接命令；EdgeOne 部署前额外通过 [EdgeOne 助手](../../scripts/lib/edgeone.mjs) 用 `EDGEONE_PROJECT_ID` 核对同名唯一性。
- **随机证明闭环**：[部署入口](../../scripts/deploy.mjs) 联合 [随机证明](../../scripts/lib/deploy-proof.mjs) 与 [上线核对](../../scripts/lib/deploy-ready.mjs) 为 Workers / ESA 建立临时上传副本并写入绑定 `(target, version, fingerprint, environment)` 的唯一随机文件；CLI 退出 0 后从目标 HTTPS 根地址（拒绝重定向；ESA staging 通过同包 Undici 连接器指定测试 IP 并保留 Host、SNI 与 TLS 证书校验）请求并比对一致才记录回执。

## 增量搜索推送与 CI/钩子策略守卫

- **IndexNow 增量推送 (`push:search`)**：[SEO 推送](../../scripts/lib/seo-push.mjs) 对比当前清单与 `OUT_DIR` 中保存的旧清单的 `sitemap.mjs` 同源 URL 差集，仅把新增页面按每批 ≤ 10,000 条提交 IndexNow；不接入需站点 token 的百度链路。
- **秘密注入与静态流水线审计**：[秘密注入助手](../../scripts/ci/run-with-secrets.mjs) 把 CI Secret 解析为标量环境变量仅注入目标子进程（过滤 `allow_` 控制字段，不打印或落盘）；[流水线守卫](../../scripts/lib/pipeline-policy.mjs) 审计 `.github/workflows/*.yml` 与 `.cnb.yml`，拒绝在常规推送中混入自动部署或条件跳过文档审计；[提交规则](../../tools/githooks/_msgrules.py) 与 [仓库守卫](../../tools/repo_maintenance_guard.py) 强制提交信息格式并拦截明文凭据。

| 异常输入或状态 | 门禁拦截结果 |
| --- | --- |
| `DEPLOY_ENV=preview` 搭配 `github` 或 `all` | `releasePlan` 上传前报错退出（GitHub 暂无独立预览环境） |
| 静态输出恰有 2,000 文件且包含 `esa` 目标 | 加上 1 证明文件超限（2,001 > 2,000），`validateDeploymentBudget` 拒绝部署 |
| 目标 CLI 成功但 HTTPS 验证返回旧证明或 301 重定向 | `waitForDeployment` 超时报错，不记录回执，`activateRelease` 拒绝更新生产指针 |

## 验证钩子

- 发布、预算与传输回归：[release.test.mjs](../../scripts/test/release.test.mjs)、[release-consumers.test.mjs](../../scripts/test/release-consumers.test.mjs)、[deploy-plan.test.mjs](../../scripts/test/deploy-plan.test.mjs)、[deploy-static.test.mjs](../../scripts/test/deploy-static.test.mjs)、[deploy-transport.test.mjs](../../scripts/test/deploy-transport.test.mjs)、[pnpm-runner.test.mjs](../../scripts/test/pnpm-runner.test.mjs)、[edgeone.test.mjs](../../scripts/test/edgeone.test.mjs)、[static-output.test.mjs](../../scripts/test/static-output.test.mjs)
- 流水线、密钥与 SEO 回归：[pipeline-policy.test.mjs](../../scripts/test/pipeline-policy.test.mjs)、[docs-workflow.test.mjs](../../scripts/test/docs-workflow.test.mjs)、[run-with-secrets.test.mjs](../../scripts/test/run-with-secrets.test.mjs)、[seo-push.test.mjs](../../scripts/test/seo-push.test.mjs)

## 延伸阅读

- 端到端构建与交接顺序：[一次真实主流程](../walkthroughs/one-real-run.md)
- 目标容量注册源码位置：[配置与目标模块](site-config-and-targets.md) · [术语表](../glossary.md)

证据状态：除特别标注外，本页基于当前源码已确认。
