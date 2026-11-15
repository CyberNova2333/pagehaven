---
layout: home

hero:
  name: 页间 · Pagehaven
  text: 纯静态漫画库与台词检索引擎
  tagline: 基于 Astro 静态输出、SQLite Wasm 全文索引与 R2 + CDN 分发的可持续数字漫画出版基础设施。
  actions:
    - theme: brand
      text: 1. 起步与部署
      link: /docs/
    - theme: alt
      text: 2. 契约与扩展
      link: /docs/boundaries
    - theme: alt
      text: 3. 架构与内核
      link: /docs/architecture
    - theme: alt
      text: GitHub 仓库
      link: https://github.com/CyberNova2333/pagehaven

features:
  - title: 每话单 HTML 与四端便携
    details: 遵守 EdgeOne、ESA（2,000 文件上限）、GitHub Pages 与 Workers 免费静态基线，无脚本时照样可读全部图文。
  - title: 浏览器端 SQLite Wasm 检索
    details: 构建期生成 FTS5 trigram 数据库与分块清单，查询经 OpenCC 繁简归一并精确跳转到 #p<n>b<i> 气泡坐标。
  - title: 私有 R2 与三阶段不可变发布
    details: 静态 HTML 与 WebP/DB 读写分离，上传、随机证明核对与 ETag 条件启用严格隔离，杜绝半截上线。
---

## 按身份 / 目标快速入口

| 你的身份与目标 | 推荐起步页面 | 深入工程依据（仓库内 `repo-docs/`） |
| --- | --- | --- |
| **站点维护者 / 部署运维**：快速搭建、预览与发布到免费边缘托管 | [项目概览与快速上手](/docs/) → [多模式运行与多平台部署](/docs/deployment) | `repo-docs/modules/release-pipeline-and-proofs.md` |
| **内容编辑 / 汉化组**：整理作品 YAML、LabelPlus 或人工校对 OCR | [配置、数据与前端契约](/docs/configuration) | `repo-docs/modules/data-model-and-normalization.md` |
| **前端 / 检索扩展开发者**：理解主题变量、书架备份、阅读器或搜索接口 | [能力边界与安全假设](/docs/boundaries) → [跨模块交互与扩展 FAQ](/docs/interactions) | `repo-docs/modules/search-db-and-chunkfetch.md` |
| **架构审计 / 新协作者**：跟读一次真实构建交接与贡献规则 | [一次真实构建与发布演练](/docs/walkthrough) → [源码地图与贡献工作流](/docs/code-map) | `repo-docs/walkthroughs/one-real-run.md` |

## 核心管线交互全景图

<div class="archify-diagram-card" style="margin: 1.5rem 0; border: 1px solid var(--vp-c-border); border-radius: 12px; overflow: hidden; background: var(--vp-c-bg-soft);">
  <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 18px; background: var(--vp-c-bg-elv); border-bottom: 1px solid var(--vp-c-border); font-size: 13px;">
    <span style="font-weight: 600; color: var(--vp-c-text-1);">
      Pagehaven 核心管线：01 原始稿件 → 02 规范化 IR → 03 发布产物 → 04 阅读引擎（支持缩放与平移探查）
    </span>
    <a href="/diagrams/pagehaven-pipeline.html" target="_blank" rel="noreferrer" style="font-size: 12px; color: var(--vp-c-brand-1); text-decoration: none; font-weight: 500;">
      在新窗口全屏打开 ↗
    </a>
  </div>
  <iframe src="/diagrams/pagehaven-pipeline.html" width="100%" height="520px" frameborder="0" style="display: block; border: none;" allowfullscreen loading="lazy"></iframe>
</div>

## 10 秒本地验证

仓库默认以空白通用模板起步，可直接运行一次真实静态构建与检查：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm --filter @gallery/site run preview
# 默认在 http://localhost:4321 预览；加载内置样本数据可设 DATA_DIR=packages/core/test/fixtures/data
```

## 四阶段文档架构

1. **起步与部署**：[项目概览](/docs/) · [多模式与多平台部署](/docs/deployment) · [部署与运行排错 FAQ](/docs/faq)
2. **契约与扩展**：[能力边界与安全假设](/docs/boundaries) · [配置、数据与前端契约](/docs/configuration) · [跨模块交互与扩展 FAQ](/docs/interactions)
3. **架构与内核原理**：[一次真实运行演练](/docs/walkthrough) · [核心子系统与架构全景](/docs/architecture) · [源码地图与贡献工作流](/docs/code-map)
4. **版本变更与迁移**：[版本变更、迁移与决策记录](/docs/changelog)
