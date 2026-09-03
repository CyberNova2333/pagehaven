# CONTRIBUTING.md — 协作方案（主干开发定制版）

> 本文件是「怎么一起干活」的约定；技术档案与决策看
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，Agent 硬约束看
> [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md)。
> 三者有冲突时：CLAUDE.md > AGENTS.md > 本文件。

## 一、分支结构：一根主线 + 两类例外

```
main（唯一长期分支，已保护：禁 force push / 禁删除）
├── 日常开发：所有人直接提交
├── 例外1：hotfix/*  —— 修主线红灯，寿命以小时计
└── 例外2：surgery/* —— core 数据模型 / 构建流水线 / 三平台适配层大改，≤ 3 天
```

- 禁止第三种分支存在，feature 分支全部用 feature flag 替代（§三）；
- `surgery/*` 开工前在 [ACTIVE.md](ACTIVE.md) 登记，完工立即合入删除；
- 超期（hotfix 24 小时、surgery 3 天）会被 `tools/check-branch-hygiene.py` 点名；
- **分支退役不许直接删**：先打 `archive/<原分支名>` tag 存档再删，走
  Actions →「🗄️ 归档分支为 tag」。

## 二、提交规则

1. **一个逻辑改动一个 commit**，禁止攒批量提交；
2. 提交前必过 `npm run check && npm test`（命令见 AGENTS.md §3）；
3. **分层验证**——按改动路径决定进入 main 的要求：

   | 改动路径 | 进入 main 的要求 |
   |---|---|
   | 文档、`data/`、`site.config.yaml` | `npm run check` |
   | `packages/core` `packages/site` `packages/search` | + `npm test` + `npm run build` 全量 |
   | `packages/platform/`、`scripts/deploy-*`、workflow | + 以 `target=<平台>` 向 preview 真实部署一次 |
   | 数据 schema、DB 结构 | + 重建 DB 并在检索页上用真实数据查一次 |

   `checks.yml` 会按 diff 路径在运行摘要里标出级别。最后两级 CI 替代不了，
   必须有人真跑过才算完。
4. `git config pull.rebase true` + `rebase.autoStash true` + `rerere.enabled true`，
   开工第一件事是 rebase 到最新 main；
5. Commit message 用 **Conventional Commits 前缀 + 中文描述**（AGENTS.md §1）；
6. **署名**：作者按实际执笔的人记，没有默认值；Agent 只做 `Co-authored-by`。

## 二之二、对外表述：只说角色，不写出处

注释、文档、提交信息里提到本仓库之外的东西时，只说它在功能上是什么：

| 写这个 | 不写这个 |
|---|---|
| 图片源站 / 检索库所在的对象存储 | 账号 ID、桶名 |
| CDN 侧 / 当前部署目标 | 具体账号、API token |
| 翻译产物的来源目录 | 翻译组内部的路径与人名 |

地址与凭据一律由 secrets 给，源码与历史里都不出现。**守卫不能去钉那个名字**
（断言「注释里必须提到 R2」的守卫，自己就成了写回来的那一处）；**提交信息同样
算对外表述**，写的时候就按这条来。

## 三、Feature Flag 规范

所有「牵一发动全身」的新功能，**代码进 main、功能默认关**。

本仓库的 flag 就是 `site.config.yaml` 的 `features:` 段（构建期读入，
静态产物里不存在关着的功能）：

- flag 打开 = 功能完成的定义，打开动作本身是一个独立 commit；
- 稳定运行一个发布周期以上才允许删除旧代码路径和 flag；
- flag 只能让站点退回更保守的形态（例如关掉函数加速、关掉某平台适配），
  **不能关掉 `npm run check` 里的任何一条守卫**。

## 四、CI 流水线

```
push 到 main
 └── checks.yml
      ├── npm run check（预算守卫、配置同步、lint）
      ├── npm test + npm run build（dry-run，不发布）
      ├── 分层提示：按 diff 路径给出验证级别
      ├── 通过 → 自动移动 tag `last-green` 到本次提交
      └── 失败 → 🔴 红灯流程（§五）

人类 workflow_dispatch
 ├── release.yml（chapters / target / ocr）
 │    ingest → build → check → publish:r2 → deploy:<target> → 写 STATUS.md
 └── 🗄️ 归档分支为 tag
```

- `last-green` 是稳定锚点：`git checkout last-green` 立刻回到最近一次全绿；
- 构建 / 发布 / 部署**只手动**；`schedule:` 一律禁止（CLAUDE.md 铁律 6）；
- 产物只进 R2 与 Artifacts，不进仓库（`STATUS.md` 例外，它就是给人看的）。

## 五、红灯协议（main 挂了的处理 SOP）

1. `checks.yml` 失败 → CI 在失败提交下留言标记 🔴；
2. 红灯期间只允许修复主线的提交推 main（pre-push 红灯闸门执行：新增提交不全是
   `fix(` / `fix:` / `revert` 开头就拦；查不到状态时放行并提示；
   逃生口 `SKIP_REDLIGHT_HOOK=1`）；
3. 引入者负责修，修不了就 `git revert` 先恢复绿灯；
4. 找不到引入者 → `git bisect` 从 `last-green` 二分定位。

红灯只影响仓库，**不影响线上站点**——线上永远是最后一次成功的 `release.yml`
产物。这也是构建与部署必须手动的原因之一。

## 六、最低限度沟通机制

- [ACTIVE.md](ACTIVE.md)：每人/每个 Agent 开工时加一行
  `日期 | 谁 | 在搞什么 | 预计动哪片`，完工删行；
- 必须发群的只有三件事：**红灯、surgery 分支开工、flag 打开**，其余免沟通。

## 七、与既有规则的关系

- 分支白名单只有 `main` / `hotfix/*` / `surgery/*`，判定在
  `tools/check-branch-hygiene.py` 与 `tools/githooks/pre_push.py` 各有一份
  `ALLOW` 表，**加例外时两处一起改并写明到期日**；
- 本仓库的 CI 触发规则比翻译组其他仓库更严：**没有任何自动发布**，连 tag 也不
  触发部署。
