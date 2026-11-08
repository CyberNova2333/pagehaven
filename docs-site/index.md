---
layout: home
repoGuideSource: "repo-docs/README.md"

hero:
  name: 页间 · Pagehaven
  text: 静态书库发布编排与边缘托管工作流
  tagline: 严密调度页面生成、构建清单校验、离线检索库构建与多平台托管回执追踪。
  actions:
    - theme: brand
      text: 开启文档阅读
      link: /walkthroughs/one-real-run
    - theme: alt
      text: 架构代码地图
      link: /code-map
    - theme: alt
      text: GitHub 仓库
      link: https://github.com/CyberNova2333/pagehaven

features:
  - title: 清单级构建一致性
    details: 强校验构建输出清单、离线搜索索引与静态资产树哈希，杜绝增量遗留导致的孤儿页面或损坏外链。
  - title: 视觉与阅读偏好系统
    details: 原生支持双主题自适应、字体字号滑条调节与质感毛玻璃呈现，兼顾阅读舒适度与现代设计感。
  - title: 多平台部署回执追踪
    details: 标准化对接 GitHub Pages、Cloudflare Pages 与自建静态托管，自动汇总交付回执与验证凭据。
---

## 这是什么

**页间 · Pagehaven** 是一个面向数字图书、结构化长篇文档与个人文库的现代化静态发布引擎与工作流管线。

它解决的是“如何把大量文本、排版规则与本地资源，安全、可靠且可验证地编译为高质感离线站点”的问题。通过构建期严格的清单校验、即时轻量检索库生成以及部署回执核验，保障最终展示给读者的页面与本地原稿毫无偏差。

## 怎么用 / 快速上手

### 1. 本地安装与开发预览

Node.js 22+ 环境下执行：

```bash
# 安装依赖
npm install

# 启动本地开发服务器并实时预览书库
npm run docs:dev
```

### 2. 编译发布包

```bash
# 执行完整构建流程（含检索索引生成与清单审计）
npm run docs:build
```

产物输出至 `docs-site/.vitepress/dist`，可直接部署至任何支持静态文件的边缘网络。

## 分层阅读与快速跳转

::: tip 按读者角色快速检索
- **初次接触 / 快速上手**：从[一次真实主流程](/walkthroughs/one-real-run)开始，追踪一份内容从原始排版、检索库编译到产物验证的生命周期。
- **架构设计 / 模块定位**：从[代码地图](/code-map)进入，查阅构建编排脚本、搜索刷新插件（GuideSearchRefresh）与主题挂载。
- **审计复核 / 核心贡献**：从[源码证据](/references/source-evidence)核对构建断言与回执证据，查阅[文档质量复核](/references/quality-review)了解边界与风险。
:::

---

## 完整项目指南概览

<!--@include: ../repo-docs/README.md-->
