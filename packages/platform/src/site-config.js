// site.config.yaml 的 schema 与解析。
//
// 这是「单一配置源」（CLAUDE.md 铁律 5）的可执行定义：所有读配置的地方——生成器、
// 构建脚本、站点、检索——都经过这里，字段名与取值约束只在此处出现一次。
// 只用 Web 标准 API：js-yaml 与 zod 都是纯 JS，浏览器里也能跑。
import yaml from 'js-yaml';
import { z } from 'zod';
import { isSafeObjectPrefix } from '@gallery/core/object-path';

// 主机名：不带协议、不带路径。域名是「切换托管平台只改 CNAME」的锚点，写错了
// 站点上所有绝对链接都跟着错，所以在 schema 里就拦。
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const hostname = z.string().regex(HOST, '必须是不带协议与路径的主机名，例如 gallery.example.org');
const absPath = z.string().regex(/^\/[^\s]*$/, '必须以 / 开头的路径');
const POWER_OF_TWO_PAGE = new Set([512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]);
const noControls = (value) => [...value].every((char) => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127);
const compatibilityDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, '兼容日期必须是真实的 YYYY-MM-DD 日期');

// 不接受脚本、内联数据、带凭据的地址与路径归一化绕过。站内资源只指向 SVG 文件；
// 图片实际是否可达由站点预览确认，解析配置时不发起网络请求。
function safeLogo(value) {
  if (value !== value.trim() || /[\s\\]/.test(value) || !noControls(value)) return false;
  if (value.startsWith('/')) {
    return !value.includes('..') && /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.svg$/i.test(value);
  }
  if (!/^https:\/\//i.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    if (!noControls(decoded) || /[\s\\]/.test(decoded) || /(?:^|\/)\.\.(?:\/|$)/.test(decoded.split(/[?#]/)[0])) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export const SiteConfigSchema = z
  .strictObject({
    site: z.strictObject({
      title: z.string().trim().min(1).max(100).refine(noControls, '名称不能包含控制字符'),
      domain: hostname,
      lang: z.string().min(2).default('zh-CN'),
      logo: z.string().max(2048).refine(safeLogo, 'Logo 必须是站内 SVG 路径或无凭据的 HTTPS 图片地址').default('/favicon.svg'),
      tagline: z.string().max(160).refine(noControls, '页脚文案不能包含控制字符').default('在页间，遇见好故事'),
    }),
    appearance: z.strictObject({
      theme: z.enum(['paper', 'ocean', 'plum']).default('paper'),
      accent: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i, '主色必须是 #RRGGBB')]).default(''),
      font: z.enum(['serif', 'sans']).default('serif'),
      show_search: z.boolean().default(true),
      show_library: z.boolean().default(true),
    }).default({ theme: 'paper', accent: '', font: 'serif', show_search: true, show_library: true }),
    images: z.strictObject({
      hosts: z.array(hostname).min(1, '至少一个图片域名').max(2, '取块层按两条源设计，多于两条请先改 ARCHITECTURE §6'),
      prefix: z.string().regex(/^[^/].*\/$/, '前缀不以 / 开头、以 / 结尾').default('img/'),
    }),
    db: z.strictObject({
      page_size: z.number().int().refine((n) => POWER_OF_TWO_PAGE.has(n), 'sqlite page_size 必须是 512–65536 之间的 2 的幂'),
      chunk_size: z.number().int().positive(),
      prefix: z.string().refine(isSafeObjectPrefix, '前缀须以 / 结尾，仅含 ASCII 字母、数字、下划线、连字符、点和目录分隔符，不能有空段或 .、.. 段').default('db/'),
      whole_download_max_bytes: z.number().int().nonnegative(),
    }),
    search: z.strictObject({
      request_chunk_size: z.number().int().positive(),
      min_match_length: z.literal(3).default(3),
      api_path: absPath.default('/api/search'),
    }),
    features: z.strictObject({
      search_function: z.boolean().default(false),
      platform_config: z.boolean().default(true),
      text_layer: z.boolean().default(true),
      comimi_reader: z.boolean().default(false),
    }),
    budgets: z.strictObject({
      // 仓库通用预算只许收紧；ESA 等目标的额外限制由平台注册表在部署前检查。
      max_files: z.number().int().positive().max(18000, '守卫线 18 000 是平台 20 000 上限留余量后的值，不能往上放'),
      max_file_bytes: z.number().int().positive().max(20971520, '守卫线 20 MB 是平台 25 MB 上限留余量后的值，不能往上放'),
    }),
    headers: z
      .array(
        z.strictObject({
          path: absPath,
          headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/, '响应头名只能是字母数字与连字符'), z.string().min(1)),
        }),
      )
      .default([]),
    redirects: z
      .array(
        z.strictObject({
          from: absPath,
          to: z.string().min(1),
          status: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).default(301),
        }),
      )
      .default([]),
    seo: z
      .strictObject({
        // IndexNow（Bing / Yandex / Naver / Seznam 等共用）的 key。协议要求它公开放在站点根
        // （https://<domain>/<key>.txt）供搜索引擎核对，所以它不是凭据、可以进配置（铁律 7 管的是
        // 账号与 token）。留空 = 不推 IndexNow。格式按协议：8–128 位字母数字与连字符。
        indexnow_key: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9-]{8,128}$/, 'IndexNow key 是 8–128 位字母、数字与连字符')]).default(''),
      })
      .default({ indexnow_key: '' }),
    deploy: z.strictObject({
      cloudflare: z.strictObject({ project: z.string().min(1) }),
      edgeone: z.strictObject({ functions_dir: z.string().min(1).default('edge-functions') }),
      github: z.strictObject({ cname: z.boolean().default(true) }),
      workers: z.strictObject({ compatibility_date: compatibilityDate.default('2026-11-02') }).default({ compatibility_date: '2026-11-02' }),
      // 实际项目名与凭据从 secrets 提供，禁止写进站点配置及生成模板。
      esa: z.strictObject({}).default({}),
    }),
  })
  .refine((c) => c.search.request_chunk_size === c.db.page_size, {
    message: 'search.request_chunk_size 必须等于 db.page_size（铁律 4：DB 的 page_size 与检索端 requestChunkSize 一致）',
    path: ['search', 'request_chunk_size'],
  })
  .refine((c) => c.db.chunk_size % c.db.page_size === 0 && c.db.chunk_size >= c.db.page_size, {
    message: 'db.chunk_size 必须是 db.page_size 的整数倍（取块层按块对齐，块内才能整页交给 sqlite）',
    path: ['db', 'chunk_size'],
  })
  .refine((c) => c.redirects.every((r) => r.from !== r.to), {
    message: '重定向的 from 与 to 相同',
    path: ['redirects'],
  });

/** @typedef {z.infer<typeof SiteConfigSchema>} SiteConfig */

/**
 * 解析并校验 site.config.yaml 的文本。校验失败抛 Error，信息里逐条列出字段路径。
 * @param {string} text
 * @returns {SiteConfig}
 */
export function parseSiteConfig(text) {
  const raw = yaml.load(text);
  const result = SiteConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  · ${i.path.join('.') || '(根)'}: ${i.message}`);
    throw new Error(`site.config.yaml 不合法：\n${lines.join('\n')}`);
  }
  return result.data;
}
