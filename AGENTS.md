# Pagehaven Agent 规范

本文件为规范单一来源；CLAUDE.md 只引用本文件。开始前读 [架构](docs/ARCHITECTURE.md)、`STATUS.md` 和相关源码；保留工作树已有内容，不凭旧文档推断实现。

## 命令与验收

| 任务 | 命令 |
| --- | --- |
| 安装 | `pnpm install --frozen-lockfile`；完整测试还需 `pnpm --dir docs-site install --frozen-lockfile` |
| 必须通过的守卫 | `pnpm run check` |
| 业务测试 | `pnpm test` |
| 完整静态构建 | `pnpm run build`（会替换生成目录与 dist） |

三项验证分别记结果，未运行不能写通过。平台适配改动还需预览环境真实部署，单测不能代替；部署按人类授权另行执行。

## 平台与数据铁律

1. `packages/core`、`packages/site`、`packages/search` 只用 fetch/Request/Response/Web Crypto/Web Streams/WebAssembly 等 Web 标准，不 import Node 或原生依赖；SQLite 只用 Wasm。Node 与原生依赖限构建期 scripts，须能在 Linux CI/Codespaces 跑。
2. 平台绑定只在 `packages/platform/`，必须能关闭并降级到 GitHub Pages 的纯静态基线：无自定义响应头、重定向或函数仍完整可用。检索和数据加载不进 Edge Functions；可选加速不可用时回退浏览器。
3. sitemap、索引和页面构建期生成；每话恰好一个 HTML。dist ≤ 18 000 文件，单文件 ≤ 20 MB，不含图片/DB；DB page_size 与 requestChunkSize 一致，配置生成物同步，sitemap 覆盖每话。依据见原架构文档预算。
4. 配置唯一来源 `site.config.yaml`；域名、缓存、响应头、重定向从这里改，不手改 `_headers`、`_redirects`、`edgeone.json`、`wrangler.jsonc`、`esa.jsonc`。平台或配置改动先记平台矩阵再改实现，各目标一起同步。四个主要目标为 Makers、ESA、GitHub Pages、Workers；`cloudflare` 保留为旧 Pages 目标，`all` 仅包含四个主要目标。ESA 额外守住 2,000 文件限制，部署控制文件不进入公开静态产物。
5. 凭据、账号 ID、桶名、实际地址只在 secrets，不入源码/文档/历史。R2 永远私有读，读走 CDN，写只在 CI。数据源只有 R2 和仓库 data；托管内容都是可再生产物。
6. 不新增绑卡、月付、平台审批或人工续期依赖。人类操作必须可在手机浏览器 + Codespaces/GitHub 页面完成，不要求维护者拥有电脑；验证进入现有 check/test 入口。
7. `STATUS.md` 由发布流水线写，禁止手改。一次性应用器、迁移脚手架、驱动流水线留仓库外；scripts/tools 只收反复使用的工具。

## 发布和分支纪律

- 默认直接 main、无 PR，除非人类明确要求。用 feature flags 管功能，不为了形式另开 feature 分支。切分支、提交与推送按当前人类授权执行。
- 仅 `hotfix/*`（修红灯，小时级）和 `surgery/*`（core/构建/三平台大改，≤3天）可例外，先登记 ACTIVE.md，全会话至多一条，优先接续现有分支。
- 开分支前 `python3 tools/check-branch-hygiene.py --can-branch` 须为 0；收尾 `python3 tools/check-branch-hygiene.py`。远端未删除的非白名单分支 2 小时内有活动时，不许另开。
- 分支退役先以 archive/<原分支名> tag 归档并确认远端，再用 GitHub Actions 归档入口删除分支；archive tag 不可变，不留长期 archive/research 分支。远端长期仅 main，短期 hotfix/surgery；main 禁强推/删除。
- 不用 ci/build/driver/success/run-id 分支触发 CI。仅 main push 可自动检查；构建/发布与归档只由人类 web_trigger 按钮触发。禁止 crontab 与自动部署，失败不新增触发分支。

## 提交、署名和内容卫生

- Conventional Commits：`type(scope): 中文描述`，允许 feat/fix/refactor/docs/test/chore/ci/perf/build。一主题一提交，写明为什么；行为/构建/部署/缓存/schema 变更正文以 `文档:` 说明同步或不影响。
- 作者是实际执笔的人，没有默认值，不确定先确认；Agent 只在末尾完整 `Co-authored-by: Name <email>` 署名。已登记：Codex <noreply@openai.com>、Claude <noreply@anthropic.com>、Kimi <noreply@moonshot.cn>、DeepSeek <noreply@deepseek.com>；新 Agent 首次贡献时登记实际通用名。
- 非初始提交必须 SSH 签名，不使用 Agent 通用签名密钥；生成密钥只向人类交公钥，私钥不外传。除既有流水线自动 STATUS 提交例外，不以 CI 机器人代作作者。
- 不改既有提交作者/署名，不写模型档位/版本、会话链接/标记、凭据及其可识别形式、私库名、内部域名/端点/主机或分发细节；外部内容只用中性功能称呼。禁止向 Agent 命名分支推送。
- 保留原有钩子与分支/红灯闸门，不改 Git 配置或绕过钩子。文档/Agent 专项维护也需守住原项目安全和平台约束。

## 现有护栏与统一维护衔接

现有 `.codex/config.toml` / `.claude/settings.json` 的 PreToolUse 入口指向 `tools/agent-guard.py`，Git 钩子在 `tools/githooks/`；手工安装入口 `bash tools/install-hooks.sh`（Windows 为 tools/install-hooks.cmd）。Python/实现/判据缺失时旧护栏放行并提示，不能据此声称检查已通过。Git 钩子保持 LF，不改成 .bat。

原护栏的 commit-msg 检查 Conventional+中文、Co-authored-by、文档行；pre-push 检查新增提交、分支纪律及红灯时修复类提交。禁止 --no-verify/-n 和覆盖 core.hooksPath；已有 `[skip-hooks]`、SKIP_MSG_HOOK、SKIP_BRANCH_HOOK、SKIP_REDLIGHT_HOOK 属维护者明示例外，不作为日常替代。

明确用户任务高于仓库模板；项目约束冲突先向人类说明，不静默选择。AGENTS 单一规范来源取代旧的双文件优先链，不影响其中的项目安全要求。

## 维护入口

贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全报告见 [SECURITY.md](SECURITY.md)。
在新克隆中运行 `python tools/repo_maintenance_guard.py install` 接入补充护栏，再用 `python tools/repo_maintenance_guard.py status` 核对配置。安装保留原有钩子；补充护栏检查暂存内容、提交标题及推送新增历史，检查无法完成时阻止操作。项目原有更严格的署名、签名、分支和验收规则继续适用。安装是配置操作，不是业务验证。

## Repo docs

`repo-docs/` is the living guide; start with [the reading path](repo-docs/README.md) and [the main walkthrough](repo-docs/walkthroughs/one-real-run.md).
This repo's `repo-docs/` guide is reader-facing Chinese documentation. When updating reader-facing guide pages, use `repo-docs-zh` when available; keep Chinese reader handles in the prose and preserve exact source identifiers for lookup.
Read current source, scripts and tests before treating the guide as implementation truth. Repo questions, behavior changes, user uncertainty, stable knowledge discovered in conversation, and knowledge about to be saved to memory trigger a foreground sync gate with `repo-docs` Sync mode when available (otherwise inspect the guide and source manually).
Choose `none`, `answer-only`, `foreground patch`, or `background sync`. Patch the smallest owning page before the final answer when a durable local gap would mislead; use background sync only with a real tracked handoff and no answer-critical gap. Do not rewrite docs for transient debug state.
Update the walkthrough for input/output or boundary changes and the code map for responsibility changes. Record meaningful guide changes and actual verification in `repo-docs/change-log.md` with `Synced through <sha>`; do not imply unrun tests passed.

文档站统一使用 VitePress 默认主题；样式与动效遵循原生主题，构建输出独立于业务界面。
