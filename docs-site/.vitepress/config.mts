// VitePress default theme; content lives in repo-docs.
import { guideLinks } from './guide-links.mts'
import { guideSearchRefresh } from './guide-search-refresh.mjs'

const pages = {
  "change-log.md": "change-log",
  "code-map.md": "code-map",
  "README.md": "",
  "references/quality-review.md": "references/quality-review",
  "references/source-evidence.md": "references/source-evidence",
  "walkthroughs/one-real-run.md": "walkthroughs/one-real-run"
}

export default {
  lang: 'zh-CN',
  title: "页间 · Pagehaven 源码指南",
  cleanUrls: true,
  vite: { plugins: [guideSearchRefresh()] },
  // guideLinks 已按正文来源处理链接，避免 include 再次重定位。
  markdown: { include: { rebaseRelativeUrls: false }, config: guideLinks(pages) },
  themeConfig: {
    siteTitle: "Pagehaven",
    nav: [
      { text: '官网首页', link: '/' },
      { text: '文档指南', link: '/walkthroughs/one-real-run' },
      { text: '代码地图', link: '/code-map' },
      { text: 'GitHub', link: 'https://github.com/CyberNova2333/pagehaven' },
    ],
    sidebar: [{ text: '源码指南', items: [
  {
    "text": "阅读路径",
    "link": "/"
  },
  {
    "text": "一次真实主流程",
    "link": "/walkthroughs/one-real-run"
  },
  {
    "text": "代码地图",
    "link": "/code-map"
  },
  {
    "text": "源码证据",
    "link": "/references/source-evidence"
  },
  {
    "text": "文档质量复核",
    "link": "/references/quality-review"
  },
  {
    "text": "同步记录",
    "link": "/change-log"
  }
] }],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
  },
}
