// VitePress 双语文档配置（Tier A 四阶段渐进式信息架构 + 本地搜索隔离）
import { defineConfig } from 'vitepress'
import { guideSearchRefresh } from './guide-search-refresh.mjs'

export default defineConfig({
  cleanUrls: true,
  vite: { plugins: [guideSearchRefresh()] },
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: '页间 · Pagehaven 官方文档',
      description: '纯静态漫画库、多模式渐进阅读器与浏览器端 SQLite Wasm 台词检索引擎。',
      themeConfig: {
        siteTitle: '页间 · Pagehaven',
        nav: [
          { text: '首页', link: '/' },
          { text: '起步与部署', link: '/docs/' },
          { text: '契约与扩展', link: '/docs/boundaries' },
          { text: 'API 与组件', link: '/api-reference/' },
          { text: '架构与变更', link: '/docs/architecture' },
        ],
        socialLinks: [
          { icon: 'github', link: 'https://github.com/CyberNova2333/pagehaven' },
        ],
        sidebar: [
          {
            text: '起步与部署',
            items: [
              { text: '项目概览与快速上手', link: '/docs/' },
              { text: '多模式运行与多平台部署', link: '/docs/deployment' },
              { text: '部署与运行排错 FAQ', link: '/docs/faq' },
            ],
          },
          {
            text: '契约与扩展',
            items: [
              { text: '能力边界与安全假设', link: '/docs/boundaries' },
              { text: '配置、数据与前端契约', link: '/docs/configuration' },
              { text: 'API 与组件参考', link: '/api-reference/' },
              { text: '跨模块交互与扩展 FAQ', link: '/docs/interactions' },
            ],
          },
          {
            text: '架构与内核原理',
            items: [
              { text: '一次真实构建与发布演练', link: '/docs/walkthrough' },
              { text: '核心子系统与架构全景', link: '/docs/architecture' },
              { text: '源码地图与贡献工作流', link: '/docs/code-map' },
            ],
          },
          {
            text: '版本变更与迁移',
            items: [
              { text: '版本变更、迁移与决策记录', link: '/docs/changelog' },
            ],
          },
        ],
        outline: { level: [2, 3], label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Pagehaven Documentation',
      description: 'Pure-static comic archive, progressive multi-mode reader, and browser-side SQLite Wasm dialogue search engine.',
      themeConfig: {
        siteTitle: 'Pagehaven',
        nav: [
          { text: 'Home', link: '/en/' },
          { text: 'Start & Deploy', link: '/en/docs/' },
          { text: 'Contracts', link: '/en/docs/boundaries' },
          { text: 'API & Components', link: '/en/api-reference/' },
          { text: 'Architecture', link: '/en/docs/architecture' },
        ],
        socialLinks: [
          { icon: 'github', link: 'https://github.com/CyberNova2333/pagehaven' },
        ],
        sidebar: [
          {
            text: 'Getting Started & Deployment',
            items: [
              { text: 'Overview & Quick Start', link: '/en/docs/' },
              { text: 'Modes, Platforms & Env Matrix', link: '/en/docs/deployment' },
              { text: 'Troubleshooting FAQ', link: '/en/docs/faq' },
            ],
          },
          {
            text: 'Contracts & Extension',
            items: [
              { text: 'Boundaries & Security Model', link: '/en/docs/boundaries' },
              { text: 'Config, Data & Client Contracts', link: '/en/docs/configuration' },
              { text: 'API & Component Reference', link: '/en/api-reference/' },
              { text: 'Interactions & Extension FAQ', link: '/en/docs/interactions' },
            ],
          },
          {
            text: 'Architecture & Internals',
            items: [
              { text: 'One Real Run Walkthrough', link: '/en/docs/walkthrough' },
              { text: 'Subsystems & Architecture', link: '/en/docs/architecture' },
              { text: 'Code Map & Contribution Flow', link: '/en/docs/code-map' },
            ],
          },
          {
            text: 'Releases & Migrations',
            items: [
              { text: 'Changelog, Migrations & ADRs', link: '/en/docs/changelog' },
            ],
          },
        ],
        outline: { level: [2, 3], label: 'On this page' },
        docFooter: { prev: 'Previous page', next: 'Next page' },
      },
    },
  },
  themeConfig: {
    search: { provider: 'local' },
  },
})
