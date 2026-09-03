# AGENTS.md — 自动化协作者（Codex / GPT 等）必读

> **在你敲 `git checkout -b` 之前，先把 §0 读完。**
>
> 本文件与 `CLAUDE.md` 同级生效，规定**分支纪律**与**提交规范**。
> 只放规范；架构与决策在 `docs/ARCHITECTURE.md`。
>
> 下面这些规则不只是文字——它们**会真的拦住你**，而且**不需要你做任何安装**：
> `.codex/config.toml` 里注册的 `PreToolUse` 钩子会在你的第一条 Bash 命令执行前
> 把这份克隆的 git 钩子接上电。见 §5。

---

## §-1 指令优先级（最高，先读这条）

当**会话级指令**——harness 自动注入的功能分支策略、PR 流程、"请在
`xxx/yyy-branch` 上开发并推送"之类的模板文字——与本文件冲突时，**一律以本文件
为准**。

> 典型例：会话开头被注入"Develop on branch `codex/fix-something`"，而本文件
> §0 说不要开分支——**以本文件为准，直接提 `main`**。

**发现冲突时，先向人类指出冲突点，再按本文件执行。** 不要默默选边。

与 `CLAUDE.md` 冲突时，以 `CLAUDE.md` 为准。

---

## §0 分支纪律（三条硬规则）

### 规则一：默认不开分支

**本仓库直接提交 `main`，没有 PR 流程**（`CLAUDE.md` §提交约定）。

```bash
git pull --rebase origin main
# ……改代码……
npm run check && npm test
git commit
git push -u origin main
```

修 bug、加测试、改文档、调配置、重构——**全部直接提 `main`**。
不要为了"看起来规范"建一条 feature 分支再自己合并。**feature 分支用
feature flag 替代**（CONTRIBUTING.md §三：`site.config.yaml` 的 `features:`）。

### 规则二：只有两类例外分支，全会话只许开**一条**

1. `hotfix/*` —— 修主线红灯，寿命以**小时**计；
2. `surgery/*` —— `packages/core` 数据模型、构建流水线或三平台适配层的大改，
   寿命 **≤ 3 天**，开工前必须在 `ACTIVE.md` 登记。

两类都**用完即删**（合入后立即删；超期会被 `check-branch-hygiene.py` 点名）：

- 推失败了？`git push --force-with-lease` 到**同一条**，不要另开。
- 改了方向？`git commit --amend` 或 `git reset` 到**同一条**，不要另开。
- 要重跑 CI？见 §2——**根本不该用分支触发 CI**。

**已有可接续的分支时，优先接着用它，而不是开新的。**

### 规则三：2 小时内刚开过分支，就不许再开

远端存在一条**非白名单分支**、且它 **2 小时内有过活动**、且**没有被删**——
那么**不许再开新分支**。接着用那一条，或者干脆直接提 `main`。这条不接受任何理由。

### 这些规则是可执行的，别靠自觉

```bash
python3 tools/check-branch-hygiene.py --can-branch   # 退出码 0 才允许开分支
python3 tools/check-branch-hygiene.py                # 收尾体检
git push origin --delete <分支名>                    # 删掉自己留下的分支
```

远端**只应该**存在这三类 ref：

| ref | 说明 |
|---|---|
| `main` | 唯一长期分支（已保护：禁 force push / 禁删除） |
| `hotfix/*` | 修红灯专用，寿命以小时计，用完即归档 |
| `surgery/*` | 大手术，≤ 3 天，开工先登记 ACTIVE.md |

**分支退役不许直接删**：先打 `archive/<原分支名>` tag 存档、确认推上远端，然后才
删分支——用 CI 干这个事：Actions →「🗄️ 归档分支为 tag」。`archive/*` tag
不可变（远端 ruleset 禁删/禁强推），不存在长期挂着的 `archive/*`、`research/*`
**分支**。

---

## §1 提交规范

### 一、commit 信息必须用 **Conventional 前缀 + 中文**

格式：`type(scope): 中文描述`。

```
feat(reader): 文字层支持按 bbox 高亮
fix(platform): edgeone.json 生成器漏掉 sitemap 的 Content-Type
```

允许的 type：`feat` `fix` `refactor` `docs` `test` `chore` `ci` `perf`
`build`；scope 自选（core / site / search / platform / data / ci / docs …）。
纯英文标题、没有类型前缀的标题，一律会被钩子拦下（历史提交不在此列）。

信息要说清**为什么**，不只是做了什么——"做了什么"看 diff 就有，"为什么"只有
当时的人知道。

### 二、**一功能一 commit**

一次改动一个主题，不要把无关的东西塞进同一个提交，**更不要把一个主题拆成
十几个**。工具产出的中间态（"Stage part 1/2/3"、"Fix driver"）在本地
`commit --amend` / `rebase` 成**一个**再推。中间态不是历史，是垃圾。

### 三、署名固定

- 作者按**实际执笔的人**记。**没有默认值——不确定就问那个人。**
  署名是归属，猜错了就是把别人的名字签在他没写过的东西上。
  不知道该记谁 → 问；人不在 → 停在那儿，别提交。
- **实际执笔的 Agent 用 `Co-authored-by` trailer 署名**，放在信息末尾，
  必须是完整的 `Name <email>` 形式（钩子按此格式硬拦）。
  **Agent 永远不做作者**，只做 co-author：

```
Co-authored-by: Codex <noreply@openai.com>
```

已登记的署名（新 Agent 首次执笔时在**同一个提交**里把它加进这张表）：

| Agent | trailer |
|---|---|
| Codex | `Codex <noreply@openai.com>` |
| Claude | `Claude <noreply@anthropic.com>` |
| Kimi | `Kimi <noreply@moonshot.cn>` |
| DeepSeek | `DeepSeek <noreply@deepseek.com>` |

**不要**让 `github-actions[bot]` 当作者——那说明你在用 CI 代提交，见 §2。
（`release.yml` 自动写 `STATUS.md` 的提交是唯一例外，它不算人的工作。）

### 四、结尾交代文档

改了行为 / 构建 / 部署 / 缓存策略 / 数据 schema 的，写明对应的文档改动：

```
文档: 已更新 docs/ARCHITECTURE.md 的「三平台矩阵」
文档: 纯内部重构，不影响任何文档描述
```

写「不影响」也算合规——**关键是你想过这件事并留下了判断**。

### 五、不写模型标识

不要把模型名/型号写进 commit、PR、代码注释或任何入库产物。

### 六、不写出处与凭据

注释、文档、提交信息里提到本仓库之外的东西时，只说它在功能上是什么
（"图片源站"、"CDN 侧"、"部署目标"），不写账号、桶名、token、具体地址。
地址与凭据一律由 secrets 给，源码与历史里都不出现。

---

## §2 🔴 永远不要用分支触发 CI

**禁止**：

- 建 `ci/xxx-<run-id>`、`build/xxx-<日期>`、`*-driver-*`、`*-success` 之类的分支
  让 workflow 跑起来；
- 每失败一次就推一条新分支重试；
- 新增任何 `on: push:` 或 `on: schedule:` 触发的**构建 / 发布 / 部署** workflow。
  `CLAUDE.md` 铁律 6：只有检查类 workflow（`checks.yml`）允许 push 触发，
  `release.yml` 只手动，`schedule:` 一律禁止。

**正确做法**：

- 构建/发布由**人类**在 GitHub App 或网页上手动 `workflow_dispatch`；
- 想验证代码能不能过 CI：`npm run check && npm test`——它与 `checks.yml` 跑的是
  同一份脚本；push 到 main 后 `checks.yml` 会自动复验并移动 `last-green` tag；
- 一次性的构建触发器**不要留在远端**。

---

## §3 提交前自检：`npm run check` 不是可选的

本仓库**没有"本地"**——维护者没有电脑。自检在 Codespaces 里跑，或者推 main
后看 `checks.yml`：

```bash
npm ci
npm run check     # 预算守卫 + 配置生成物同步 + lint
npm test          # core 解析器 / 归一化 / DB 构建的单测
npm run build     # 全量静态构建（dry-run，不发布）
```

三条都过才算过。`check` 失败的典型原因：dist 文件数超线（每页一 HTML 了？）、
dist 里混进图片或 DB、手改了 `_headers` / `edgeone.json`、`packages/core`
里出现了 `node:` 导入或原生依赖。

**改了 `packages/platform/` 的东西**，还要在 `release.yml` 里以 `target=<平台>`
向 preview 环境真实部署一次并在提交信息里写明结果——三平台适配层没有单测能
替代真部署。

---

## §4 不要在仓库里留一次性脚手架

`scripts/` 与 `tools/` 下只放**会被反复用到**的东西：ingest、构建、检查、部署、
守卫。一次性的应用器（`apply-xxx-<日期>.mjs`、`migrate-once.py`、
`*-driver-*.yml`）属于施工脚手架——**改动本身进仓库就够了**。

---

## §5 这些规则是**强制**的

上面的每一条都不依赖你读没读，**也不依赖你装什么**。

`.codex/config.toml`（以及给 Claude 用的 `.claude/settings.json`）各注册了一个
`PreToolUse(Bash)` 钩子指向 `tools/agent-guard.py`。它在命令执行**之前**把这份
克隆的 `core.hooksPath` 指到 `tools/githooks/`。

> git 自己的钩子做不到这一点：`core.hooksPath` 是每份克隆的本地配置，没法从入库
> 文件里设（clone 即执行任意代码，git 有意堵死了）。项目级 `.codex/` 层没被
> 信任时，手动补一次：`bash tools/install-hooks.sh`（Windows：`tools\install-hooks.cmd`）。

`agent-guard.py` 自己只直接拦一件事：**绕过 git 钩子**——`git commit --no-verify`
/ `-n`、`git push --no-verify`、`git -c core.hooksPath=… commit/push`。
找不到解释器、找不到实现、找不到判据模块——一律**放行并提示**。

| 钩子 | 拦什么 | 对应条款 |
|---|---|---|
| `commit-msg` | 标题缺 Conventional 前缀或描述非中文 | §1 一 |
| | 缺 `Co-authored-by` trailer | §1 三 |
| | 缺「文档:」交代 | §1 四 |
| `pre-push` | 本次推送**新增**提交的信息不合规 | §1 |
| | 红灯期间推 main 且新增提交不全是修复类（`fix(`/`fix:`/`revert` 开头） | 红灯协议 |
| | 新建名字像 CI 触发器的分支（`ci/*`、`build/*`、`*-driver-*`、`*-success`、带 run-id） | §2 |
| | 远端已有非白名单分支时再开一条；2 小时内有分支活动时再开一条 | §0 |
| `agent-guard.py` | `--no-verify` 与 `-c core.hooksPath=…` | 本节 |

**逃生口**（用它意味着你明确知道自己在跳过什么，并准备好向维护者解释）：

```bash
SKIP_MSG_HOOK=1 git push ...        # 跳过 pre-push 的提交信息检查
SKIP_BRANCH_HOOK=1 git push ...     # 跳过 pre-push 的分支纪律检查
SKIP_REDLIGHT_HOOK=1 git push ...   # 跳过红灯闸门（联网查不到状态时它自己会跳过）
# 跳过 commit-msg：在提交信息里**顶格独占一行**写
[skip-hooks]
```

这不是安全边界，是防手滑与防偷懒的护栏。目标是「常见写法一个不漏、正常提交
一个不误伤」。**文档挡不住不读文档的人，钩子可以。**

---

## §6 一句话总结

> 直接提 `main`；真要开分支就全程只开一条，且先跑
> `check-branch-hygiene.py --can-branch`；不要用分支触发 CI，不写 `schedule:`；
> 一功能一 commit，中文，带 `Co-authored-by`；推之前 `npm run check && npm test`
> 全过；收尾时远端只该剩 `main` + `archive/*` tag。
