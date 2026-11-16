import type { ApiCatalogSpec } from './api-types'

export const apiSpecZh: ApiCatalogSpec = {
  project: '页间 Pagehaven · API、Schema 与组件参考',
  subtitle:
    '覆盖单一配置源 site.config.yaml、@gallery/core / @gallery/search 纯 Web 标准模块、阅读器深链与备份 Schema，以及四端静态发布流水线 CLI。',
  environments: [
    { label: '本地 Astro 预览', value: 'http://localhost:4321' },
    { label: '可视化配置器 (Token 鉴权)', value: 'http://127.0.0.1:4318' },
    { label: '生产 CDN 示例基址', value: 'https://gallery.example.org' },
  ],
  searchPlaceholder: '搜索 Schema、包导出、CLI 或约束关键词…',
  emptyText: '没有找到匹配的 Schema、组件或 CLI 条目。',
  labels: {
    allGroups: '全部',
    canDo: '✅ 能做到',
    cannotDo: '⛔ 明确限制 / 拒绝条件',
    params: '字段、参数与不变量约束',
    paramName: '字段 / 参数',
    paramLocation: '作用域',
    paramType: '类型',
    paramRequired: '约束',
    paramDesc: '说明与校验规则',
    responses: '输出契约与失败条件',
    examples: '标准调用 / 配置示例',
    responseSample: '标准产出 / 载荷示例',
    copy: '复制',
    copied: '已复制',
    noParams: '该组件无额外必填参数。',
    required: '必填 / 强约束',
    optional: '可选',
    deepDocs: '查看深入规范文档',
    totalItems: '项组件/契约',
    envLabel: '示例环境基址',
    mobilePicker: '切换 API 或组件',
    defaultLabel: '默认',
    plainIndexToggle: '纯文本检索与打印索引（Ctrl+K 站内搜索定位）',
  },
  groups: [
    { id: 'schema', title: '配置与数据 Schema' },
    { id: 'core', title: '核心库与检索 API' },
    { id: 'reader', title: '阅读器与书架组件' },
    { id: 'ops', title: '构建与三阶段发布 CLI' },
  ],
  items: [
    {
      id: 'schema-site-config',
      group: 'schema',
      kind: 'CONFIG',
      title: '单一配置源 site.config.yaml',
      signature: 'parseSiteConfig(yamlText) -> SiteConfig',
      auth: '静态构建校验 (Zod strictObject)',
      stability: '核心 SSOT',
      summary:
        '定义站点域名、图片 CDN 主机、SQLite 分块/页大小、平台预算与发布开关；所有生成器与浏览器端均只读这一份配置定义。',
      relatedLink: '/docs/configuration',
      relatedLabel: '查看配置契约详解',
      capabilities: [
        '通过 build:config 统一生成 _headers、_redirects、edgeone.json、wrangler.jsonc 与 esa.jsonc',
        '强制锁定 search.request_chunk_size === db.page_size 与 db.chunk_size 整倍数关系',
        '校验站点与 CDN 主机名为无协议纯域名，防止 CNAME 切换后全站链接失效',
      ],
      limitations: [
        '生产发布直接拒绝 example.org、localhost 等占位域名',
        'images.hosts 最多允许 2 个域名；search.min_match_length 锁定为 3，不接受小于 3',
        '不允许写入 R2 密钥、Cloudflare Token 或 ESA 项目凭据；esa 块保持空对象 {}',
      ],
      params: [
        {
          name: 'site.domain',
          location: 'config',
          type: 'hostname',
          required: true,
          description: '纯主机名（不含协议与路径），也是 GitHub CNAME 锚点。',
        },
        {
          name: 'images.hosts',
          location: 'config',
          type: 'hostname[1..2]',
          required: true,
          description: '对外读图的 CDN 域名数组，最多 2 个；禁止直连私有 R2 桶。',
        },
        {
          name: 'db.page_size / chunk_size',
          location: 'config',
          type: 'number',
          required: true,
          defaultValue: '4096 / 65536',
          description: 'page_size 须为 512–65536 的 2 的幂；chunk_size 须为其正整数倍。',
        },
        {
          name: 'budgets.max_files / max_file_bytes',
          location: 'config',
          type: 'number',
          required: true,
          defaultValue: '18000 / 20971520',
          description: '全站静态产物仅许收紧不得放宽（20 MiB 单文件 / 18,000 文件上限）。',
        },
        {
          name: 'features.*',
          location: 'config',
          type: 'boolean map',
          required: true,
          description: 'platform_config、text_layer、comimi_reader、search_function 开关；关闭仅退回保守形态。',
        },
      ],
      responses: [
        {
          status: 'SiteConfig 对象',
          tone: 'ok',
          summary: 'Zod strictObject 与跨字段 refine 全部通过，供下游包消费',
          example: `{
  "site": { "title": "页间 · Pagehaven", "domain": "gallery.example.org", "lang": "zh-CN" },
  "images": { "hosts": ["images.example.org"], "prefix": "img/" },
  "db": { "page_size": 4096, "chunk_size": 65536, "prefix": "db/", "whole_download_max_bytes": 31457280 },
  "search": { "request_chunk_size": 4096, "min_match_length": 3, "api_path": "/api/search" }
}`,
        },
        {
          status: 'Error (字段级拒收)',
          tone: 'err',
          summary: '存在未知字段、非法 SVG Logo、或 chunk_size / page_size 未对齐时抛错阻断',
        },
      ],
      examples: [
        {
          label: 'site.config.yaml',
          lang: 'yaml',
          code: `site:
  title: 页间 · Pagehaven
  domain: manga.example.com
  lang: zh-CN
images:
  hosts: [img.example.com]
  prefix: img/
db:
  page_size: 4096
  chunk_size: 65536
  whole_download_max_bytes: 31457280`,
        },
        {
          label: 'JS 校验调用',
          lang: 'javascript',
          code: `import { readFileSync } from 'node:fs'
import { parseSiteConfig } from '@gallery/platform/site-config'

const cfg = parseSiteConfig(readFileSync('site.config.yaml', 'utf8'))
console.log(cfg.db.page_size, cfg.images.hosts)`,
        },
      ],
    },
    {
      id: 'schema-meta-yaml',
      group: 'schema',
      kind: 'SCHEMA',
      title: '作品与章节元数据 Schema',
      signature: 'parseSeriesMeta(yaml) · SeriesSchema / ChapterSchema',
      auth: '纯 Web 标准 Zod',
      stability: '构建强约束',
      summary:
        '约束 data/meta/*.yaml 的作品、刊期、话与页码结构，保证 URL 段、R2 图片 key 与 #p<n> 页码深链三者严格一致。',
      relatedLink: '/docs/configuration',
      relatedLabel: '查看目录与图片规范',
      capabilities: [
        '校验作品 / 期 / 话三级 ID 唯一性与小写连字符格式',
        '确保每页宽高 (w/h) 与图片内容 SHA-256 前 12 位 img 完整',
      ],
      limitations: [
        'id 不可使用大写字母或未加引号的纯数字前导零（如 012 须写为 "012"）',
        'pages[].n 必须严格从 1 起连续递增 1, 2, 3…，不允许跳页或空章',
      ],
      params: [
        {
          name: 'id',
          location: 'field',
          type: 'string',
          required: true,
          description: '匹配 /^[a-z0-9][a-z0-9-]{0,62}$/，同时充当 URL 路由段与图片路径段。',
        },
        {
          name: 'pages[].n',
          location: 'field',
          type: 'integer (>= 1)',
          required: true,
          description: '严格从 1 递增；直接决定阅读器页序与 #p<n> 深链。',
        },
        {
          name: 'pages[].img',
          location: 'field',
          type: 'hex12',
          required: true,
          description: '匹配 /^[0-9a-f]{12}$/ 的图片内容 SHA-256 前 12 位。',
        },
      ],
      responses: [
        {
          status: 'SeriesMeta',
          tone: 'ok',
          summary: '输出通过校验的作品树结构，可直接喂给 buildGalleryDb 与 Astro 构建',
          example: `{
  "id": "demo-series",
  "title": "示例连载",
  "issues": [{
    "id": "vol-01",
    "number": 1,
    "chapters": [{ "id": "ch-01", "number": 1, "pages": [{ "n": 1, "img": "a1b2c3d4e5f6", "w": 1200, "h": 1800 }] }]
  }]
}`,
        },
        {
          status: 'Error (校验失败)',
          tone: 'err',
          summary: '页码断层、同级 ID 重复或 img 摘要格式不合法时中止构建',
        },
      ],
      examples: [
        {
          label: 'data/meta YAML',
          lang: 'yaml',
          code: `id: demo-series
title: 示例作品
status: ongoing
issues:
  - id: vol-01
    number: 1
    title: 第一辑
    chapters:
      - id: "001"
        number: 1
        title: 第一话
        pages:
          - { n: 1, img: a1b2c3d4e5f6, w: 1200, h: 1800 }`,
        },
      ],
    },
    {
      id: 'schema-text-layer',
      group: 'schema',
      kind: 'SCHEMA',
      title: '坐标化台词层 ChapterTextSchema',
      signature: 'parseChapterText(json) · TextBoxSchema',
      auth: 'data/text/*.json',
      stability: '构建与前端共用',
      summary:
        '存储与阅读器分辨率无关的归一化台词框坐标（0–1 比例）及原句文本，由 LabelPlus 或校对后 OCR 稿导入生成。',
      relatedLink: '/docs/configuration',
      relatedLabel: '查看导入与台词格式',
      capabilities: [
        '兼容矩形文本框（x/y/w/h ∈ [0, 1]）及 LabelPlus 标号点标记（w=0, h=0）',
        '每条框按 i 顺序索引，供检索结果生成 #p<n>b<i> 高亮定位锚点',
      ],
      limitations: [
        '坐标超出 [0, 1] 闭区间或文本框 i 乱序将被 check:data 拒绝',
        'ingest:ocr 产出的未校对草稿不自动进入此目录，须人工审核后用 --accept-reviewed 导入',
      ],
      params: [
        {
          name: 'i',
          location: 'field',
          type: 'integer >= 0',
          required: true,
          description: '单页内文本框序号，构成 #p<n>b<i> 片段的 b<i>。',
        },
        {
          name: 'x / y / w / h',
          location: 'field',
          type: 'number [0..1]',
          required: true,
          description: '归一化页面比例坐标；点状标注允许 w=0, h=0。',
        },
        {
          name: 't',
          location: 'field',
          type: 'string',
          required: true,
          description: '展示原文台词（检索索引会额外走 5 步 normalizeText 归档到 text_norm）。',
        },
      ],
      responses: [
        {
          status: 'ChapterText',
          tone: 'ok',
          summary: '供 Astro 页面文字层与 SQLite FTS5 trigram 建库共用',
          example: `{
  "pages": [
    { "n": 1, "boxes": [{ "i": 0, "x": 0.42, "y": 0.18, "w": 0.16, "h": 0.12, "t": "签订契约吧。" }] }
  ]
}`,
        },
        {
          status: 'ValidationError',
          tone: 'err',
          summary: '任意坐标越界或未知额外字段时拒绝落盘',
        },
      ],
      examples: [
        {
          label: '导入 CLI',
          lang: 'sh',
          code: `pnpm run ingest:labelplus -- --series demo --issue vol-01 --chapter 001 --file raw/ch001.txt
pnpm run ingest:ocr -- --accept-reviewed raw/ocr/ch001.json`,
        },
      ],
    },
    {
      id: 'core-search-query',
      group: 'core',
      kind: 'SDK',
      title: '文本归一化与混合台词检索',
      signature: 'normalizeText(s) · prepareQuery(q) · queryLines(db, q, opts)',
      auth: '纯 Web 标准 (Zero Node API)',
      stability: '核心稳定接口',
      summary:
        '保证构建期建库与浏览器端查询执行完全一致的 5 步幂等归一化，并根据有效字数自动在拒绝 / LIKE 全表扫 / FTS5 trigram 间调度。',
      relatedLink: '/docs/architecture',
      relatedLabel: '查看归一化与查询源码说明',
      capabilities: [
        '执行 NFKC → 清除标点符号/变体选择符 → 次轮 NFKC → OpenCC 繁转简 → 小写，覆盖繁简异体字',
        '按 1 字拒绝 / 2 字转义 LIKE / >=3 字 FTS5 MATCH 自动分流，并按书架顺序每批返回最多 50 条与 #p<n>b<i> 跳转地址',
      ],
      limitations: [
        '归一化后不足 2 个字符（too-short）时直接拒绝查询，也不触发 SQLite 数据库下载',
        'FTS5 内部双引号会自动转义为短语检索，不支持用户直接输入布尔 OR/NEAR 语法操作符',
      ],
      params: [
        {
          name: 'rawQuery',
          location: 'arg',
          type: 'string',
          required: true,
          description: '读者输入的原始检索词，内部自动经过 normalizeText。',
        },
        {
          name: 'limit',
          location: 'arg',
          type: 'integer (1..50)',
          required: false,
          defaultValue: '50',
          description: '每批最大返回行数；超限抛 RangeError。',
        },
        {
          name: 'offset / seriesId',
          location: 'arg',
          type: 'integer / string',
          required: false,
          description: '分页偏移量及可选作品级过滤 ID。',
        },
      ],
      responses: [
        {
          status: 'mode: "match" | "like"',
          tone: 'ok',
          summary: '返回 rows 列表（含坐标 x/y/w/h 与跳转 url）和 hasMore 游标',
          example: `{
  "mode": "match",
  "normalized": "签订契约",
  "rows": [
    {
      "seriesId": "demo-series",
      "chapterUrl": "/demo-series/vol-01/001/",
      "pageN": 1,
      "boxI": 0,
      "text": "簽訂契約！",
      "url": "/demo-series/vol-01/001/#p1b0"
    }
  ],
  "hasMore": false
}`,
        },
        {
          status: 'mode: "too-short"',
          tone: 'warn',
          summary: '归一化不足 2 字时返回空 rows 与 hasMore: false，避免无意义全表扫描',
        },
      ],
      examples: [
        {
          label: 'JS SDK',
          lang: 'javascript',
          code: `import { normalizeText } from '@gallery/core'
import { prepareQuery, queryLines } from '@gallery/search'

const plan = prepareQuery('簽訂「契約」')
// => { normalized: '签订契约', mode: 'match' }
if (plan.mode !== 'too-short') {
  const res = queryLines(db, '簽訂契約', { limit: 50, offset: 0 })
  console.log(res.rows[0]?.url)
}`,
        },
      ],
    },
    {
      id: 'core-load-db',
      group: 'core',
      kind: 'SDK',
      title: '版本锁定与校验检索库加载',
      signature: 'loadGalleryDb({ config, fetchImpl, signal })',
      auth: 'CDN SigV4 公开可读产物',
      stability: '浏览器运行时',
      summary:
        '按站点构建时锁定的 release 元数据（或指定 CDN manifest）流式下载 SQLite 数据库，先验流字节长度上限再核对 SHA-256，最后移交 @sqlite.org/sqlite-wasm。',
      relatedLink: '/docs/boundaries',
      relatedLabel: '查看检索体积上限与安全假设',
      capabilities: [
        '优先命中 HTML 固化的版本化 gallery-<version>.sqlite，避免旧页面查到新版本库结构',
        '支持多 images.hosts 依次故障转移，20 秒超时与 AbortSignal 取消联动清理读取流',
      ],
      limitations: [
        '超出 db.whole_download_max_bytes（默认 30 MiB）时直接报错拒载，防止撑爆移动端内存',
        '若提供了显式 release 元数据但格式缺失/不匹配，不会静默回退到线上最新库',
      ],
      params: [
        {
          name: 'config.images.hosts',
          location: 'config',
          type: 'string[]',
          required: true,
          description: 'HTTPS CDN 域名列表；按序尝试拉取。',
        },
        {
          name: 'config.db.whole_download_max_bytes',
          location: 'config',
          type: 'number',
          required: false,
          defaultValue: '31457280',
          description: '硬性整库下载上限（字节），同时在预读 Header 与流接收循环中双重检查。',
        },
      ],
      responses: [
        {
          status: 'Promise<Database>',
          tone: 'ok',
          summary: 'SHA-256 验证一致并成功打开的内存 SQLite 实例（由调用方负责 close）',
        },
        {
          status: 'Error (超时 / 超限 / 摘要不符)',
          tone: 'err',
          summary: '任何一步不匹配立即 abort 流并发起清理',
        },
      ],
      examples: [
        {
          label: '加载与查询',
          lang: 'javascript',
          code: `import { loadGalleryDb, queryLines } from '@gallery/search'

const db = await loadGalleryDb({ config: window.__PAGEHAVEN_CONFIG__ })
try {
  const hits = queryLines(db, '奇迹')
  console.log(hits.rows.length)
} finally {
  db.close()
}`,
        },
      ],
    },
    {
      id: 'core-chunkfetch',
      group: 'core',
      kind: 'SDK',
      title: '多源 HTTP Range 分块层 (@gallery/core/chunkfetch)',
      signature: 'ChunkedFile / probe(url) / SourceSet',
      auth: '实验性底层基建',
      stability: '未接入浏览器 VFS',
      summary:
        '独立实现的 64 KiB 块级探测、EMA 延迟选源与逐块 SHA-256 校验客户端；为未来超 30 MiB 检索库突破整库下载限制准备底层原语。',
      relatedLink: '/docs/architecture',
      relatedLabel: '查看架构定位',
      capabilities: [
        '支持 HEAD/Range 探测服务端 206 切片能力、跨源指数退避重试与块缓存',
        '对每个 65,536 字节分块验证 sha256Hex，防 CDN 返回篡改或截断分片',
      ],
      limitations: [
        '当前版本尚未接入浏览器端 SQLite VFS（线上 /search/ 仍走 loadGalleryDb 整库上限路线）',
        '当源服务器忽略 Range 头返回 200 全量时，主动抛出 ChunkFetchError("needs-whole")',
      ],
      params: [
        {
          name: 'SourceSet',
          location: 'arg',
          type: 'object',
          required: true,
          description: '管理至多 2 个 CDN 源的健康度与指数移动平均 (EMA) 响应延迟。',
        },
        {
          name: 'chunkSize',
          location: 'config',
          type: 'number',
          required: false,
          defaultValue: '65536',
          description: '需与 db.chunk_size 及清单 chunks.json 切分长度一致。',
        },
      ],
      responses: [
        {
          status: 'Uint8Array (Verified Chunk)',
          tone: 'info',
          summary: '返回通过 SHA-256 校验的 64 KiB 字节分片并写入 LRU 缓存',
        },
        {
          status: 'ChunkFetchError (needs-whole)',
          tone: 'warn',
          summary: '全部源都不支持 Range 切片时明确拒绝分块读并提示退回整份加载',
        },
      ],
      examples: [
        {
          label: '分块探测与读取',
          lang: 'javascript',
          code: `import { ChunkedFile, SourceSet, probe } from '@gallery/core/chunkfetch'

const support = await probe('https://img.example.com/db/gallery-2026-11-16.sqlite')
if (support.ok) {
  const sources = new SourceSet(['https://img.example.com'])
  const file = new ChunkedFile({ urlPath: 'db/gallery-2026-11-16.sqlite', manifest, sources })
  const bytes = await file.read(0, 4096)
}`,
        },
      ],
    },
    {
      id: 'reader-hash-and-modes',
      group: 'reader',
      kind: 'CLASS',
      title: '阅读器深链与渐进增强控制',
      signature: '/<series>/<issue>/<chapter>/#p<n>b<i> · mountEnhancedReader()',
      auth: '无脚本纯静态可读',
      stability: '阅读核心契约',
      summary:
        '每话输出一份独立 HTML，无 JS 即可流式阅读图片与文字层；加载脚本后接管单页/条漫（二分法定位）/双页切换、100 话目录分片以及可选 Comimi 分页。',
      relatedLink: '/docs/interactions',
      relatedLabel: '查看跨模块交互详情',
      capabilities: [
        '长条模式采用页顶坐标二分查找（1,000 页最多约 10 次位置测定）并精准高亮 #p<n>b<i> 台词框',
        '打开完整目录时按需请求 /index/<series>.json（每组 100 话分片），维持静态页常数体积',
      ],
      limitations: [
        '启用 Comimi 增强分页 (mountEnhancedReader) 时，处于长条模式或选中文字层/台词高亮状态会自动暂停增强并交还原生阅读器',
        '三态明暗系统与进度仅作用于当前浏览器本地；绝不上报任何服务端遥测',
      ],
      params: [
        {
          name: '#p<n>',
          location: 'path',
          type: 'URL fragment',
          required: false,
          description: '跳至第 n 页（从 1 计数）。',
        },
        {
          name: '#p<n>b<i>',
          location: 'path',
          type: 'URL fragment',
          required: false,
          description: '跳至第 n 页并高亮第 i 个台词文本框（检索跳转常用格式）。',
        },
      ],
      responses: [
        {
          status: 'DOM 高亮与视图定位',
          tone: 'ok',
          summary: '切换页码、滚动到目标台词框边界、并持续同步 localStorage 阅读进度',
        },
      ],
      examples: [
        {
          label: '深链访问 URL',
          lang: 'text',
          code: `{{BASE_URL}}/demo-series/vol-01/001/#p3
{{BASE_URL}}/demo-series/vol-01/001/#p3b1`,
        },
      ],
    },
    {
      id: 'reader-backup-schema',
      group: 'reader',
      kind: 'SCHEMA',
      title: '本地书架与阅读进度备份 Schema',
      signature: 'parseReadingBackup(jsonText) · format: "pagehaven-reading-backup"',
      auth: '纯浏览器迁移 (/library/)',
      stability: '版本 v1 锁定',
      summary:
        '在无账号体系的前提下，通过严格的 JSON 白名单格式在多台设备间安全导出与恢复书架状态、阅读进度、页码书签与笔记。',
      relatedLink: '/docs/boundaries',
      relatedLabel: '查看个人数据存储约定',
      capabilities: [
        '仅导入白名单四类键：library（想看/在看/已读）、progress、bookmarks 与 notes（≤200 字）',
        '逐条校验 chapterKey 正则、去重页码并自动拦截异常原型链字段与 BOM 头干扰',
      ],
      limitations: [
        '硬性拒绝超过 5 MiB（5,242,880 字节）或累计超过 20,000 条记录的备份文件',
        '遇到未知额外顶层/子字段、重复标识或 version !== 1 时整包拒载，绝不部分写入',
      ],
      params: [
        {
          name: 'format / version',
          location: 'body',
          type: '"pagehaven-reading-backup" / 1',
          required: true,
          description: '固定格式魔数与版本标识，确保跨版本可区分。',
        },
        {
          name: 'notes[].note',
          location: 'body',
          type: 'string (<= 200 chars)',
          required: false,
          description: '单页笔记文本，严格限制最多 200 字符。',
        },
      ],
      responses: [
        {
          status: 'Validated Backup Object',
          tone: 'ok',
          summary: '清洗去重并准备写入 localStorage 的完整四表对象',
          example: `{
  "format": "pagehaven-reading-backup",
  "version": 1,
  "createdAt": 1763290000000,
  "library": [{ "seriesId": "demo-series", "status": "reading", "updatedAt": 1763290000000 }],
  "progress": [{ "chapterKey": "demo-series/vol-01/001", "n": 3, "ts": 1763290000000 }],
  "bookmarks": [{ "chapterKey": "demo-series/vol-01/001", "pages": [1, 3] }],
  "notes": []
}`,
        },
        {
          status: 'Error (超限或字段非法)',
          tone: 'err',
          summary: '超过 5 MiB、20,000 条或字段校验失败时安全中止导入',
        },
      ],
      examples: [
        {
          label: 'JS 校验示例',
          lang: 'javascript',
          code: `import { parseReadingBackup } from '@gallery/site/lib/reading-backup'

const backup = parseReadingBackup(rawJsonString)
console.log(backup.library.length, backup.bookmarks.length)`,
        },
      ],
    },
    {
      id: 'ops-build-and-check',
      group: 'ops',
      kind: 'CLI',
      title: '全量构建与预算合规检查 CLI',
      signature: 'pnpm run build && DEPLOY_TARGET=all pnpm run check',
      auth: '本地 / CI 离线门禁',
      stability: '主干门禁',
      summary:
        '串联配置模板生成、资源清单校验、SQLite Wasm 建库、Astro 静态输出与 sitemap，并在打包发布前验证所有平台文件数及字节上限。',
      relatedLink: '/docs/deployment',
      relatedLabel: '查看构建与检查矩阵',
      capabilities: [
        '依据 TARGET_CAPABILITIES 校验 workers(18,000 文件)、esa(2,000 文件 / 1,024,000,000 B)、github(1,000,000,000 B)',
        '同时审计 sharp 禁用状态、Web 标准边界、generated 配置同步及 README 锚点连通性',
      ],
      limitations: [
        'DEPLOY_ENV=preview 配合 target github 或 all 会直接失败（GitHub Pages 无预览环境）',
        '若 site.config.yaml 仍保留 example.org 等示例域，生产发布检查直接阻断',
      ],
      params: [
        {
          name: 'DATA_DIR / DIST_DIR / OUT_DIR',
          location: 'env',
          type: 'path',
          required: false,
          description: '路径覆盖变量，常用于指向内置测试夹具 packages/core/test/fixtures/data 做冒烟构建。',
        },
        {
          name: 'DEPLOY_TARGET',
          location: 'env',
          type: 'cloudflare | edgeone | github | workers | esa | all',
          required: false,
          description: '让 pnpm run check 激活指定目标的文件数与体积预算检查。',
        },
      ],
      responses: [
        {
          status: 'Exit 0',
          tone: 'ok',
          summary: '静态站、SQLite 检索库与多平台配置全部就绪且符合上限预算',
        },
        {
          status: 'Exit 1 (预算或同步校验失败)',
          tone: 'err',
          summary: '配置漂移、ESA 超 1,999 业务文件或测试失败时精准报错退出',
        },
      ],
      examples: [
        {
          label: '夹具冒烟构建',
          lang: 'sh',
          code: `DATA_DIR=packages/core/test/fixtures/data DIST_DIR=/tmp/p-dist OUT_DIR=/tmp/p-out pnpm run build
DEPLOY_TARGET=all pnpm run check`,
        },
      ],
    },
    {
      id: 'ops-release-pipeline',
      group: 'ops',
      kind: 'CLI',
      title: 'R2 不可变上传与条件指针切换 CLI',
      signature: 'publish:r2 -> release:prepare -> deploy:<target> -> release:activate',
      auth: 'CI Secrets (禁止本地明文配置)',
      stability: '三阶段发布流水线',
      summary:
        '将 WebP 媒体和带版本号检索库上传私有 Cloudflare R2 后，逐目标发布静态站并用随机部署证明文件核验真实 HTTPS 生效，全部通过后以 ETag CAS 切换线上指针。',
      relatedLink: '/docs/deployment',
      relatedLabel: '查看三阶段发布详解',
      capabilities: [
        '使用 If-Match / If-None-Match 原子更新 manifest.json，彻底避免部分平台失败时污染线上版本',
        'workers 与 esa 部署时在临时上传副本写入随机证明文件，并从实际 HTTPS 地址做端到端拉取核验',
      ],
      limitations: [
        '严格受 pipeline-policy.mjs 守护：不允许任何自动推送阶段隐式触发生产部署（须手动调度）',
        '如某一个目标部署失败或证明核验超时，release:activate 拒绝对 manifest.json 切换指针',
      ],
      params: [
        {
          name: 'RELEASE_VERSION',
          location: 'env',
          type: 'string ([A-Za-z0-9._-]+)',
          required: false,
          defaultValue: 'UTC YYYY-MM-DD',
          description: '固定本次 SQLite 检索库及版本清单后缀。',
        },
        {
          name: 'R2_* / CLOUDFLARE_* / EDGEONE_* / ESA_*',
          location: 'env',
          type: 'secret',
          required: true,
          description: '仅由 CI secret 经 run-with-secrets.mjs 注入单子进程，严禁进配置文件与日志。',
        },
      ],
      responses: [
        {
          status: 'Exit 0 (Atomic Activated)',
          tone: 'ok',
          summary: '所有选定目标均通过随机证明并写入同指纹 manifest.json',
        },
        {
          status: 'Exit 1 (Rollback Safe / Pointer Unchanged)',
          tone: 'err',
          summary: '任意目标失败即中止激活，旧版本在线指针纹丝不动',
        },
      ],
      examples: [
        {
          label: '三阶段发布流水线',
          lang: 'sh',
          code: `pnpm run publish:r2
pnpm run release:prepare
pnpm run deploy:workers
pnpm run deploy:esa
pnpm run release:activate
pnpm run push:search && pnpm run status`,
        },
      ],
    },
  ],
}

export const apiSpecEn: ApiCatalogSpec = {
  project: 'Pagehaven · API, Schema & Component Reference',
  subtitle:
    'Covers the site.config.yaml SSOT schema, @gallery/core & @gallery/search Web-standard SDKs, reader deep links and backup validation, plus the three-phase R2 & static deployment CLI.',
  environments: [
    { label: 'Local Astro Preview', value: 'http://localhost:4321' },
    { label: 'Local Customizer (Token-Auth)', value: 'http://127.0.0.1:4318' },
    { label: 'Production CDN Example', value: 'https://gallery.example.org' },
  ],
  searchPlaceholder: 'Filter schemas, SDK exports, CLI scripts…',
  emptyText: 'No matching schema, component, or CLI entry found.',
  labels: {
    allGroups: 'All',
    canDo: '✅ Capabilities',
    cannotDo: '⛔ Explicit Limits / Rejections',
    params: 'Fields, Arguments & Invariants',
    paramName: 'Field / Argument',
    paramLocation: 'Scope',
    paramType: 'Type',
    paramRequired: 'Constraint',
    paramDesc: 'Description & Validation Rules',
    responses: 'Outputs & Failure Conditions',
    examples: 'Standard Invocation / Config',
    responseSample: 'Sample Payload / Output',
    copy: 'Copy',
    copied: 'Copied',
    noParams: 'No additional required parameters.',
    required: 'Required / Enforced',
    optional: 'Optional',
    deepDocs: 'Read full contract guide',
    totalItems: 'specs',
    envLabel: 'Sample Environment Base',
    mobilePicker: 'Select API or Component',
    defaultLabel: 'Default',
    plainIndexToggle: 'Plaintext Search & Print Index (Ctrl+K Target)',
  },
  groups: [
    { id: 'schema', title: 'Config & Data Schemas' },
    { id: 'core', title: 'Core SDK & Search APIs' },
    { id: 'reader', title: 'Reader & Library Modules' },
    { id: 'ops', title: 'Build & 3-Phase Release CLI' },
  ],
  items: [
    {
      id: 'schema-site-config',
      group: 'schema',
      kind: 'CONFIG',
      title: 'SSOT Configuration site.config.yaml',
      signature: 'parseSiteConfig(yamlText) -> SiteConfig',
      auth: 'Build-Time Zod strictObject',
      stability: 'Core SSOT',
      summary:
        'Single canonical configuration defining canonical domain, image CDN hosts, SQLite page/chunk sizing, hosting budgets, and feature flags across build and browser modules.',
      relatedLink: '/en/docs/configuration',
      relatedLabel: 'View full configuration contract',
      capabilities: [
        'Drives generated _headers, _redirects, edgeone.json, wrangler.jsonc, and esa.jsonc via build:config',
        'Enforces search.request_chunk_size === db.page_size and integer multiple chunk alignment',
        'Validates bare hostnames so DNS CNAME platform swaps never leave stale hardcoded origins',
      ],
      limitations: [
        'Production releases reject placeholder hosts such as example.org or localhost',
        'Caps images.hosts at 2 CDN hosts and pins search.min_match_length strictly to 3',
        'Rejects R2/Cloudflare/ESA secrets inside config; esa remains an empty object {}',
      ],
      params: [
        {
          name: 'site.domain',
          location: 'config',
          type: 'hostname',
          required: true,
          description: 'Protocol-free canonical host; also populates GitHub Pages CNAME.',
        },
        {
          name: 'images.hosts',
          location: 'config',
          type: 'hostname[1..2]',
          required: true,
          description: '1–2 public CDN hostnames reading privately from Cloudflare R2 via SigV4.',
        },
        {
          name: 'db.page_size / chunk_size',
          location: 'config',
          type: 'number',
          required: true,
          defaultValue: '4096 / 65536',
          description: 'page_size must be a power of 2 in 512–65536; chunk_size must be an integer multiple.',
        },
        {
          name: 'budgets.max_files / max_file_bytes',
          location: 'config',
          type: 'number',
          required: true,
          defaultValue: '18000 / 20971520',
          description: 'Conservative global budget ceilings; never relaxed above 18,000 files or 20 MiB.',
        },
      ],
      responses: [
        {
          status: 'SiteConfig Object',
          tone: 'ok',
          summary: 'Strict schema validated object consumed identically across generators and @gallery/search',
          example: `{
  "site": { "title": "Pagehaven", "domain": "gallery.example.org", "lang": "zh-CN" },
  "images": { "hosts": ["images.example.org"], "prefix": "img/" },
  "db": { "page_size": 4096, "chunk_size": 65536, "prefix": "db/", "whole_download_max_bytes": 31457280 }
}`,
        },
        {
          status: 'Validation Error',
          tone: 'err',
          summary: 'Fails fast with dot-separated paths on unknown keys or alignment mismatches',
        },
      ],
      examples: [
        {
          label: 'JS Parser Call',
          lang: 'javascript',
          code: `import { readFileSync } from 'node:fs'
import { parseSiteConfig } from '@gallery/platform/site-config'

const cfg = parseSiteConfig(readFileSync('site.config.yaml', 'utf8'))
console.log(cfg.db.page_size, cfg.images.hosts)`,
        },
      ],
    },
    {
      id: 'schema-meta-yaml',
      group: 'schema',
      kind: 'SCHEMA',
      title: 'Series, Issue & Chapter Metadata Schema',
      signature: 'parseSeriesMeta(yaml) · SeriesSchema / ChapterSchema',
      auth: 'Web-Standard Zod',
      stability: 'Core Data Contract',
      summary:
        'Validates data/meta/*.yaml structure so URL slugs, immutable content-addressed R2 image keys, and #p<n> reader offsets stay synchronized.',
      relatedLink: '/en/docs/configuration',
      relatedLabel: 'View data schema docs',
      capabilities: [
        'Validates unique lowercase-alphanumeric hyphenated IDs across series, issues, and chapters',
        'Requires explicit width/height and 12-hex SHA-256 img digests for every page',
      ],
      limitations: [
        'Unquoted leading-zero numeric IDs (like 012) parsed as YAML numbers are rejected explicitly',
        'Page numbers pages[].n must start at 1 and increment contiguously without gaps',
      ],
      params: [
        {
          name: 'id',
          location: 'field',
          type: 'string',
          required: true,
          description: 'Matches /^[a-z0-9][a-z0-9-]{0,62}$/, shared across URL paths and object storage keys.',
        },
        {
          name: 'pages[].n / img',
          location: 'field',
          type: 'integer / hex12',
          required: true,
          description: '1-based contiguous page number and 12-hex SHA-256 content prefix.',
        },
      ],
      responses: [
        {
          status: 'Validated SeriesMeta',
          tone: 'ok',
          summary: 'Clean typed metadata object ready for buildGalleryDb and Astro page generation',
        },
        {
          status: 'Validation Error',
          tone: 'err',
          summary: 'Rejects duplicate IDs, skipped page numbers, or non-hex image keys',
        },
      ],
      examples: [
        {
          label: 'data/meta YAML',
          lang: 'yaml',
          code: `id: demo-series
title: Demo Archive
issues:
  - id: vol-01
    number: 1
    title: Volume 1
    chapters:
      - id: "001"
        number: 1
        title: Chapter 1
        pages:
          - { n: 1, img: a1b2c3d4e5f6, w: 1200, h: 1800 }`,
        },
      ],
    },
    {
      id: 'schema-text-layer',
      group: 'schema',
      kind: 'SCHEMA',
      title: 'Dialogue Layer ChapterTextSchema',
      signature: 'parseChapterText(json) · TextBoxSchema',
      auth: 'data/text/*.json',
      stability: 'Search & Reader Shared',
      summary:
        'Resolution-independent unit coordinates ([0, 1]) and verbatim dialogue strings powering selectable overlays and FTS5 trigram indexing.',
      relatedLink: '/en/docs/configuration',
      relatedLabel: 'View ingest docs',
      capabilities: [
        'Supports bounding boxes (x/y/w/h in [0, 1]) as well as LabelPlus pin markers (w=0, h=0)',
        'Assigns stable per-page index i consumed by #p<n>b<i> search deep links',
      ],
      limitations: [
        'Out-of-range coordinates outside [0, 1] fail data checks',
        'Unreviewed OCR drafts are excluded from indexing until promoted with --accept-reviewed',
      ],
      params: [
        {
          name: 'i / x / y / w / h / t',
          location: 'field',
          type: 'box tuple',
          required: true,
          description: 'Zero-based box ordinal, unit box ratios (0..1), and raw dialogue text.',
        },
      ],
      responses: [
        {
          status: 'ChapterText',
          tone: 'ok',
          summary: 'Feeds Astro text overlays and normalized SQLite dialogue indexing',
        },
      ],
      examples: [
        {
          label: 'Ingest Commands',
          lang: 'sh',
          code: `pnpm run ingest:labelplus -- --series demo --issue vol-01 --chapter 001 --file raw/ch001.txt
pnpm run ingest:ocr -- --accept-reviewed raw/ocr/ch001.json`,
        },
      ],
    },
    {
      id: 'core-search-query',
      group: 'core',
      kind: 'SDK',
      title: 'Text Normalization & Hybrid Search',
      signature: 'normalizeText(s) · prepareQuery(q) · queryLines(db, q, opts)',
      auth: 'Pure Web Standard',
      stability: 'Core Public API',
      summary:
        'Applies identical 5-step idempotent normalization at build time and query time, routing between rejection (<2 chars), escaped LIKE (2 chars), and FTS5 trigram MATCH (>=3 chars).',
      relatedLink: '/en/docs/architecture',
      relatedLabel: 'Inspect normalization internals',
      capabilities: [
        'Runs NFKC -> punctuation/selector strip -> NFKC -> OpenCC Traditional-to-Simplified -> lowercase',
        'Returns up to 50 reading-order results per batch with hasMore cursor and #p<n>b<i> deep links',
      ],
      limitations: [
        'Queries normalizing to <2 characters return mode: "too-short" and never download SQLite',
        'Escapes double quotes into literal FTS phrases; arbitrary boolean operator injection is disallowed',
      ],
      params: [
        {
          name: 'rawQuery',
          location: 'arg',
          type: 'string',
          required: true,
          description: 'User search input; normalized automatically before length checks and SQL execution.',
        },
        {
          name: 'limit / offset / seriesId',
          location: 'arg',
          type: 'number / string',
          required: false,
          defaultValue: 'limit = 50',
          description: 'Bounded result slice (1..50), non-negative offset, and optional series filter.',
        },
      ],
      responses: [
        {
          status: 'mode: "match" | "like"',
          tone: 'ok',
          summary: 'Returns rows with bbox coordinates and direct #p<n>b<i> jump URLs',
          example: `{
  "mode": "match",
  "normalized": "签订契约",
  "rows": [{ "chapterUrl": "/demo-series/vol-01/001/", "pageN": 1, "boxI": 0, "url": "/demo-series/vol-01/001/#p1b0" }],
  "hasMore": false
}`,
        },
        {
          status: 'mode: "too-short"',
          tone: 'warn',
          summary: 'Skips database queries when fewer than 2 normalized characters remain',
        },
      ],
      examples: [
        {
          label: 'SDK Usage',
          lang: 'javascript',
          code: `import { prepareQuery, queryLines } from '@gallery/search'

const plan = prepareQuery('契約')
if (plan.mode !== 'too-short') {
  const result = queryLines(db, '契約', { limit: 50, offset: 0 })
  console.log(result.rows)
}`,
        },
      ],
    },
    {
      id: 'core-load-db',
      group: 'core',
      kind: 'SDK',
      title: 'Pinned & SHA-256 Verified DB Loader',
      signature: 'loadGalleryDb({ config, fetchImpl, signal })',
      auth: 'Public CDN over Private R2',
      stability: 'Browser Runtime',
      summary:
        'Downloads the build-pinned SQLite search index across configured CDN hosts with hard streaming byte budgets and SHA-256 verification before opening SQLite Wasm.',
      relatedLink: '/en/docs/boundaries',
      relatedLabel: 'Review search size guards',
      capabilities: [
        'Pins HTML output to matching schema DB release version so stale HTML never hits new DB shapes',
        'Supports multi-host fallback, 20s timeout, and hard stream truncation protection',
      ],
      limitations: [
        'Refuses databases larger than db.whole_download_max_bytes (30 MiB default)',
        'Pinned release errors fail explicitly without silently falling back to a drifting unpinned pointer',
      ],
      params: [
        {
          name: 'config.images.hosts / db.whole_download_max_bytes',
          location: 'config',
          type: 'string[] / number',
          required: true,
          defaultValue: '31457280',
          description: 'Ordered CDN host list and maximum byte budget allowed for whole-DB fetch.',
        },
      ],
      responses: [
        {
          status: 'Promise<Database>',
          tone: 'ok',
          summary: 'Verified in-memory SQLite instance; caller is responsible for calling db.close()',
        },
        {
          status: 'Error',
          tone: 'err',
          summary: 'Aborts and rejects on size overflow, timeout, or SHA-256 mismatch',
        },
      ],
      examples: [
        {
          label: 'Browser Loader',
          lang: 'javascript',
          code: `import { loadGalleryDb, queryLines } from '@gallery/search'

const db = await loadGalleryDb({ config: window.__PAGEHAVEN_CONFIG__ })
try {
  console.log(queryLines(db, 'contract'))
} finally {
  db.close()
}`,
        },
      ],
    },
    {
      id: 'core-chunkfetch',
      group: 'core',
      kind: 'SDK',
      title: 'Multi-Source Range Module (@gallery/core/chunkfetch)',
      signature: 'ChunkedFile / probe(url) / SourceSet',
      auth: 'Pre-VFS Foundation',
      stability: 'Standalone Tested',
      summary:
        'Web-standard 64 KiB HTTP Range client featuring EMA latency host scoring, backoff retries, and per-chunk SHA-256 verification.',
      relatedLink: '/en/docs/architecture',
      relatedLabel: 'Read architecture context',
      capabilities: [
        'Verifies HTTP 206 Range compliance and validates each 65,536-byte chunk hash against chunks.json',
        'Routes around flaky CDN mirrors with EMA latency ranking and cached LRU blocks',
      ],
      limitations: [
        'Not yet wired into browser SQLite VFS (live /search/ currently relies on bounded whole-file loadGalleryDb)',
        'Throws ChunkFetchError("needs-whole") immediately if origins ignore Range headers',
      ],
      params: [
        {
          name: 'SourceSet / chunkSize',
          location: 'arg',
          type: 'object / number',
          required: true,
          defaultValue: '65536',
          description: 'Source health pool and byte alignment matching db.chunk_size.',
        },
      ],
      responses: [
        {
          status: 'Verified Uint8Array Chunk',
          tone: 'info',
          summary: 'SHA-256 verified chunk cached and sliced cleanly',
        },
        {
          status: 'ChunkFetchError (needs-whole)',
          tone: 'warn',
          summary: 'Explicit signal to fall back when upstreams return HTTP 200 without Range slicing',
        },
      ],
      examples: [
        {
          label: 'Range Probe',
          lang: 'javascript',
          code: `import { probe, SourceSet } from '@gallery/core/chunkfetch'
const cap = await probe('https://img.example.com/db/gallery.sqlite')
const sources = new SourceSet(['https://img.example.com'])`,
        },
      ],
    },
    {
      id: 'reader-hash-and-modes',
      group: 'reader',
      kind: 'CLASS',
      title: 'Reader Deep Links & Progressive Enhancement',
      signature: '/<series>/<issue>/<chapter>/#p<n>b<i> · mountEnhancedReader()',
      auth: 'Zero-JS Baseline',
      stability: 'Reader Contract',
      summary:
        'Single static HTML per chapter stays readable without JS, upgrading client-side to single/long-strip (O(log N) binary search)/double-page layouts, 100-item catalog shards, and opt-in Comimi pagination.',
      relatedLink: '/en/docs/interactions',
      relatedLabel: 'Inspect reader & enhancement rules',
      capabilities: [
        'Locates active page in O(log N) (<=10 reads for 1,000 pages) and highlights target #p<n>b<i> speech bubbles',
        'Fetches /index/<series>.json in 100-chapter slices only when full TOC drawer opens',
      ],
      limitations: [
        'Optional Comimi viewer automatically pauses whenever Long-Strip mode or dialogue text/highlight mode is active',
        'Preferences, theme, and progress remain strictly browser-local with zero telemetry',
      ],
      params: [
        {
          name: '#p<n> / #p<n>b<i>',
          location: 'path',
          type: 'URL fragment',
          required: false,
          description: '1-based page target and optional zero-based speech bubble box index.',
        },
      ],
      responses: [
        {
          status: 'Active Page & Highlight',
          tone: 'ok',
          summary: 'Navigates to target page, highlights dialogue coordinates, and syncs localStorage',
        },
      ],
      examples: [
        {
          label: 'Reader URLs',
          lang: 'text',
          code: `{{BASE_URL}}/demo-series/vol-01/001/#p3
{{BASE_URL}}/demo-series/vol-01/001/#p3b1`,
        },
      ],
    },
    {
      id: 'reader-backup-schema',
      group: 'reader',
      kind: 'SCHEMA',
      title: 'Portable Reading Backup JSON Schema',
      signature: 'parseReadingBackup(jsonText) · format: "pagehaven-reading-backup"',
      auth: 'Local Browser Import/Export',
      stability: 'v1 Locked Schema',
      summary:
        'Strict allowlist backup schema moving shelves, chapter progress, bookmarks, and 200-char notes safely between devices without accounts.',
      relatedLink: '/en/docs/boundaries',
      relatedLabel: 'View client storage boundaries',
      capabilities: [
        'Strictly accepts four registered stores: library, progress, bookmarks, and notes (<=200 chars)',
        'Strips UTF-8 BOM, deduplicates sorted bookmark page arrays, and rejects prototype keys',
      ],
      limitations: [
        'Rejects files over 5 MiB or more than 20,000 total records',
        'Rejects unknown keys, invalid IDs, duplicate keys, or version !== 1 atomically without partial writes',
      ],
      params: [
        {
          name: 'format / version / library / progress / bookmarks / notes',
          location: 'body',
          type: 'exact object',
          required: true,
          description: 'Strict v1 schema fields checked before mutating browser localStorage.',
        },
      ],
      responses: [
        {
          status: 'Validated Backup Object',
          tone: 'ok',
          summary: 'Cleaned v1 JSON ready to apply to local storage',
          example: `{
  "format": "pagehaven-reading-backup",
  "version": 1,
  "createdAt": 1763290000000,
  "library": [{ "seriesId": "demo-series", "status": "reading", "updatedAt": 1763290000000 }],
  "progress": [{ "chapterKey": "demo-series/vol-01/001", "n": 3, "ts": 1763290000000 }],
  "bookmarks": [{ "chapterKey": "demo-series/vol-01/001", "pages": [1, 3] }],
  "notes": []
}`,
        },
        {
          status: 'Error',
          tone: 'err',
          summary: 'Fails safely with explicit reason when file size, record count, or field schema violates constraints',
        },
      ],
      examples: [
        {
          label: 'JS Validator',
          lang: 'javascript',
          code: `import { parseReadingBackup } from '@gallery/site/lib/reading-backup'
const parsed = parseReadingBackup(fileText)`,
        },
      ],
    },
    {
      id: 'ops-build-and-check',
      group: 'ops',
      kind: 'CLI',
      title: 'Full Build & Target Budget Gate',
      signature: 'pnpm run build && DEPLOY_TARGET=all pnpm run check',
      auth: 'Local / CI Gate',
      stability: 'Required Before Push',
      summary:
        'Compiles config templates, manifests, SQLite FTS DB, Astro HTML, shards, and sitemaps, verifying static budgets and repository guardrails.',
      relatedLink: '/en/docs/deployment',
      relatedLabel: 'View full deployment matrix',
      capabilities: [
        'Checks file/size limits for workers (18k files), esa (2k files / 1.024 GB), and github (1 GB)',
        'Enforces zero-sharp packaging, Web-standard boundaries, generated config parity, and README anchors',
      ],
      limitations: [
        'Fails immediately if DEPLOY_ENV=preview targets github or all (GitHub Pages lacks previews)',
        'Blocks production build/release whenever placeholder domains remain in site.config.yaml',
      ],
      params: [
        {
          name: 'DATA_DIR / DIST_DIR / OUT_DIR / DEPLOY_TARGET',
          location: 'env',
          type: 'path / target',
          required: false,
          description: 'Override data fixture path or select target capability checks.',
        },
      ],
      responses: [
        {
          status: 'Exit 0',
          tone: 'ok',
          summary: 'Build artifacts, SQLite index, and platform budgets verified cleanly',
        },
        {
          status: 'Exit 1',
          tone: 'err',
          summary: 'Fails on config drift, budget overflow (e.g., ESA >1,999 app files), or broken links',
        },
      ],
      examples: [
        {
          label: 'Fixture Build Check',
          lang: 'sh',
          code: `DATA_DIR=packages/core/test/fixtures/data DIST_DIR=/tmp/p-dist OUT_DIR=/tmp/p-out pnpm run build
DEPLOY_TARGET=all pnpm run check`,
        },
      ],
    },
    {
      id: 'ops-release-pipeline',
      group: 'ops',
      kind: 'CLI',
      title: 'R2 Immutable Upload & Proof-Verified Activation',
      signature: 'publish:r2 -> release:prepare -> deploy:<target> -> release:activate',
      auth: 'CI Secrets via run-with-secrets.mjs',
      stability: 'Three-Phase Pipeline',
      summary:
        'Publishes WebP media and versioned SQLite artifacts to private R2, verifies random deployment proof URLs over HTTPS per target, and activates manifest.json via ETag CAS.',
      relatedLink: '/en/docs/deployment',
      relatedLabel: 'View release pipeline guide',
      capabilities: [
        'Uses conditional If-Match / If-None-Match updates on manifest.json to avoid partial production flips',
        'Fetches randomized proof files over live HTTPS (including staging IP + SNI checks for ESA) before signing off',
      ],
      limitations: [
        'pipeline-policy.mjs forbids auto-deploy steps inside normal push CI jobs',
        'Any single failed target or proof mismatch aborts manifest.json pointer activation cleanly',
      ],
      params: [
        {
          name: 'RELEASE_VERSION / CI Secret Env Vars',
          location: 'env',
          type: 'string / secret',
          required: true,
          defaultValue: 'UTC YYYY-MM-DD',
          description: 'Immutable version tag and per-child-process injected secrets.',
        },
      ],
      responses: [
        {
          status: 'Exit 0 (Atomic Pointer Activated)',
          tone: 'ok',
          summary: 'All targets share identical release proof receipts and pointer updated atomically',
        },
        {
          status: 'Exit 1 (Pointer Untouched)',
          tone: 'err',
          summary: 'Previous production manifest stays active when any target proof fails',
        },
      ],
      examples: [
        {
          label: 'Three-Phase Commands',
          lang: 'sh',
          code: `pnpm run publish:r2
pnpm run release:prepare
pnpm run deploy:workers && pnpm run deploy:esa
pnpm run release:activate && pnpm run status`,
        },
      ],
    },
  ],
}
