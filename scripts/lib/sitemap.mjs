// sitemap.xml / sitemap index / robots.txt / IndexNow key 文件的生成逻辑（纯函数为主）。
//
// 为什么抽出来：「站点有哪些 URL」这个答案有三个消费者——build:sitemap 写文件、向搜索引擎推送
// 新页面的脚本挑增量、check 守卫核对每一话都在 sitemap 里。三处各拼一遍就会出现三套事实，
// 推送的 URL 与 sitemap 对不上时搜索引擎那边只会静默丢弃。
//
// URL 清单同时接受两种输入：loadGallery 的内存模型与 out/manifest.json。两者在这里用到的字段
// （series[].url、issues[].url / published、chapters[].url）同形，差别只在没有 published 时
// manifest 写 null、模型是 undefined。推送脚本在部署之后跑、手里只有 manifest，不该再读 data/
// 重建模型，所以入口必须认 manifest；两条路径的产出逐条相同（测试断言）。
//
// 分片：协议上限是一个文件 50 000 条 URL / 50 MB，超过就得换成 sitemap index。这里按 45 000 拆
// 留余量。文件名固定：sitemap.xml 是单文件或 index，分片叫 sitemap-<n>.xml（n 从 1 起）。
// robots.txt 永远只指 sitemap.xml——是单文件还是 index 对搜索引擎透明，站点长大换形态时
// robots 与外部登记的地址都不用改。
//
// index 里每个 <sitemap> 的 <lastmod> 是「生成日」，由调用方传入：纯函数里不 new Date()，
// 同一份输入两次调用要得到逐字节相同的输出，测试才能钉住形状。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 单文件 / index 的固定文件名；robots.txt 与外部登记都只认它。 */
export const SITEMAP_FILE = 'sitemap.xml';
/** 协议上限：一个 sitemap 文件最多 50 000 条 URL。check 守卫按它核对每个分片。 */
export const SITEMAP_PROTOCOL_MAX_URLS = 50000;
/** 实际拆分线：留 5 000 条余量，免得贴着上限被某家实现算法差异判超。 */
export const SITEMAP_MAX_PER_FILE = 45000;
/** 分片文件名；与 shardName 配对，build:sitemap 用它清掉上次留下的过期分片。 */
export const SITEMAP_SHARD_RE = /^sitemap-\d+\.xml$/;
/** 不随数据变化的固定页面：首页与检索页。 */
export const FIXED_PATHS = ['/', '/search/'];

const XMLNS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 与 site-config.js 里 IndexNow key 的约束相同。这里再钉一次，因为 key 会变成站点根目录下的文件名：
// 除了字母数字与连字符之外的任何字符（尤其 / 与 ..）都可能把文件写到 dist 之外或撞上别的文件
export const INDEXNOW_KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

/** @param {number} n 从 1 起 */
export function shardName(n) {
  return `sitemap-${n}.xml`;
}

/**
 * 站点根：必须是带协议、不带路径的绝对形式。<loc> 要绝对 URL，少了协议搜索引擎会整条丢掉而不报错，
 * 所以在这里拦。末尾多余的 / 去掉，拼路径时统一由路径自带。
 * @param {string} origin
 */
function normalizeOrigin(origin) {
  const o = String(origin ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s?#]+$/.test(o)) {
    throw new Error(`origin 必须是 https://<domain> 这种不带路径的绝对形式：${JSON.stringify(origin)}`);
  }
  return o;
}

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unescapeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * @typedef {object} SitemapEntry
 * @property {string} loc      绝对 URL
 * @property {string} [lastmod] YYYY-MM-DD；没有就不写这个 key（两条入口的产出才能 deepEqual）
 */

/**
 * 站点全部 URL：首页、/search/、每个作品 / 期 / 话，按模型顺序。期与其各话的 lastmod 取期的 published
 * （话没有自己的日期；没有 published 就不写）。
 * @param {{ series: Array<{ url: string, issues: Array<{ url: string, published?: string|null,
 *   chapters: Array<{ url: string }> }> }> }} model  loadGallery 的模型或 out/manifest.json
 * @param {string} origin  https://<domain>
 * @returns {SitemapEntry[]}
 */
export function siteUrls(model, origin) {
  const base = normalizeOrigin(origin);
  const entry = (path, lastmod) => (lastmod ? { loc: base + path, lastmod } : { loc: base + path });
  const entries = FIXED_PATHS.map((p) => entry(p));
  for (const s of model.series) {
    entries.push(entry(s.url));
    for (const iss of s.issues) {
      // manifest 的 null 与模型的 undefined 在这里归一：两者都表示「没有日期」
      const lastmod = iss.published || undefined;
      entries.push(entry(iss.url, lastmod));
      for (const c of iss.chapters) entries.push(entry(c.url, lastmod));
    }
  }
  return entries;
}

function renderUrlset(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${XMLNS}">`,
    ...entries.map((e) => `  <url><loc>${escapeXml(e.loc)}</loc>${e.lastmod ? `<lastmod>${escapeXml(e.lastmod)}</lastmod>` : ''}</url>`),
    '</urlset>',
    '',
  ].join('\n');
}

function renderIndex(shards) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sitemapindex xmlns="${XMLNS}">`,
    ...shards.map((s) => `  <sitemap><loc>${escapeXml(s.loc)}</loc><lastmod>${escapeXml(s.lastmod)}</lastmod></sitemap>`),
    '</sitemapindex>',
    '',
  ].join('\n');
}

/**
 * 渲染成要写进 dist 的文件。条数 ≤ maxPerFile 时只有一个 sitemap.xml（urlset）；超过时 sitemap.xml
 * 是 index，指向 sitemap-1.xml … sitemap-<k>.xml，每片 ≤ maxPerFile 条，index 里每个 <sitemap> 带
 * <lastmod>=today。
 * @param {SitemapEntry[]} entries
 * @param {{ origin: string, maxPerFile?: number, today?: string }} opts
 *   today：生成日（UTC，YYYY-MM-DD），只在拆成 index 时用到；拆分而没给就报错，不偷偷省略 lastmod
 * @returns {Array<{ name: string, xml: string }>}
 */
export function renderSitemaps(entries, { origin, maxPerFile = SITEMAP_MAX_PER_FILE, today } = {}) {
  const base = normalizeOrigin(origin);
  if (!Number.isInteger(maxPerFile) || maxPerFile < 1 || maxPerFile > SITEMAP_PROTOCOL_MAX_URLS) {
    throw new Error(`maxPerFile 必须是 1–${SITEMAP_PROTOCOL_MAX_URLS} 的整数（协议上限 50 000 条）：${maxPerFile}`);
  }
  if (entries.length <= maxPerFile) return [{ name: SITEMAP_FILE, xml: renderUrlset(entries) }];
  if (!DATE_RE.test(today ?? '')) {
    throw new Error(`${entries.length} 条 URL 超过 ${maxPerFile}，要拆成 sitemap index：index 里的 <lastmod> 需要 today（YYYY-MM-DD），收到 ${JSON.stringify(today)}`);
  }
  const shards = [];
  for (let i = 0; i < entries.length; i += maxPerFile) shards.push(entries.slice(i, i + maxPerFile));
  const index = renderIndex(shards.map((_, i) => ({ loc: `${base}/${shardName(i + 1)}`, lastmod: today })));
  return [{ name: SITEMAP_FILE, xml: index }, ...shards.map((s, i) => ({ name: shardName(i + 1), xml: renderUrlset(s) }))];
}

/**
 * robots.txt：全站允许抓取，Sitemap 永远指 sitemap.xml（单文件或 index 对搜索引擎透明）。
 * @param {string} origin
 */
export function renderRobots(origin) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${normalizeOrigin(origin)}/${SITEMAP_FILE}\n`;
}

/**
 * 读回 sitemap 文件的 <loc>。只认自己生成的两种形状（urlset / sitemapindex），用正则抓，不引 XML 解析器：
 * check 守卫与测试都靠它，守卫不该为一次核对多拉一个依赖。
 * @param {string} xml
 * @returns {{ index: boolean, locs: string[] }}  index 为真表示这是 sitemapindex，locs 是各分片的 URL
 */
export function parseSitemap(xml) {
  const index = /<sitemapindex[\s>]/.test(xml);
  if (!index && !/<urlset[\s>]/.test(xml)) throw new Error('不是 sitemap：既没有 <urlset> 也没有 <sitemapindex>');
  const locs = [];
  for (const m of xml.matchAll(/<loc>([^<]*)<\/loc>/g)) locs.push(unescapeXml(m[1].trim()));
  return { index, locs };
}

/**
 * IndexNow key 文件的名字与内容：https://<domain>/<key>.txt，内容就是 key。协议按字节比对文件内容与
 * key，所以内容末尾不带换行。seo.indexnow_key 为空 → null（不启用 IndexNow，不写文件）。
 * @param {{ seo?: { indexnow_key?: string } }} config
 * @returns {{ name: string, content: string } | null}
 */
export function indexNowKeyFile(config) {
  // 配置 schema 给 seo 段设了默认值；这里再兜一次，缺了整段时按「未启用」处理而不是 TypeError
  const key = config.seo?.indexnow_key ?? '';
  if (key === '') return null;
  if (!INDEXNOW_KEY_RE.test(key)) throw new Error(`seo.indexnow_key 只能是 8–128 位字母、数字与连字符（它会成为站点根的文件名）：${JSON.stringify(key)}`);
  return { name: `${key}.txt`, content: key };
}

/**
 * 按配置把 IndexNow key 文件写进 distDir。返回写出的路径；key 为空时不写、返回 null。
 * @param {{ seo?: { indexnow_key?: string } }} config
 * @param {string} distDir
 * @returns {Promise<string | null>}
 */
export async function writeIndexNowKeyFile(config, distDir) {
  const file = indexNowKeyFile(config);
  if (!file) return null;
  await mkdir(distDir, { recursive: true });
  const path = join(distDir, file.name);
  await writeFile(path, file.content);
  return path;
}
