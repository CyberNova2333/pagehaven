// 站点页面共用的纯函数：图片 URL、URL 由 key 推导、百分比坐标。
//
// 放在 .js 里而不是各页 frontmatter 里，是为了让 lint 管得到（.astro 不在 lint 范围）、
// 也让「图片 URL 怎么拼」只出现一次——它是阅读器、检索结果、爬虫三处都要一致的东西。
// 只用 Web 标准 API（铁律 1）：这里没有任何 Node 导入。

/**
 * 图片的公开 URL：https://<图片域名>/<key>。浏览器永远只见 CDN 域名，不见对象存储（铁律 7）。
 * @param {string} host  site.config.yaml 的 images.hosts 之一
 * @param {string} key   对象存储内的 key，例如 img/s/v/c/1-<hash12>.webp
 */
export function imageUrl(host, key) {
  return `https://${host}/${key}`;
}

/** 站内 URL 由 chapter key 推：'/' + key + '/'（与 @gallery/core 的 urlFor 同形）。 */
export function urlForKey(key) {
  return `/${key}/`;
}

/**
 * 以 key 为键的全部话的查找表：上一话 / 下一话链接要显示标题，模型里只有 key。
 * 全站一张表，只该建一次——在 getStaticPaths（整个构建跑一次）里建，不要放进每话都跑的 frontmatter。
 * @param {{series: Array<{issues: Array<{chapters: Array<{key: string}>}>}>}} gallery
 * @returns {Map<string, object>}
 */
export function chaptersByKey(gallery) {
  const map = new Map();
  for (const s of gallery.series) for (const iss of s.issues) for (const c of iss.chapters) map.set(c.key, c);
  return map;
}

/** @param {{issues: Array<{chapters: unknown[]}>}} series */
export function chapterCount(series) {
  return series.issues.reduce((n, iss) => n + iss.chapters.length, 0);
}

/** 0–1 的归一化坐标 → CSS 百分比；小数位截到 4 位，18 000 话的 HTML 里省掉无意义的长尾。 */
export function pct(v) {
  return `${Number((v * 100).toFixed(4))}%`;
}

/**
 * 文字框的定位样式。w=h=0 的框（LabelPlus 的点标签）只给 left/top：宽高为 0 时文本靠 overflow
 * 露出来，点标记由 CSS 的 ::before 画。
 * @param {{x: number, y: number, w: number, h: number}} box
 */
export function boxStyle(box) {
  const pos = `left:${pct(box.x)};top:${pct(box.y)}`;
  return isDot(box) ? pos : `${pos};width:${pct(box.w)};height:${pct(box.h)}`;
}

/** @param {{w: number, h: number}} box */
export function isDot(box) {
  return box.w === 0 && box.h === 0;
}

/**
 * 内联到 <script type="application/json"> 里的 JSON：把 < 换成 \u003c（JSON 字符串转义，语义不变），
 * 免得数据里出现 </script 时把标签提前关掉。
 * @param {unknown} value
 */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * 图片加载失败时切换图片域名：把 URL 里的 //<from>/ 换成 //<to>/。只匹配带两侧分隔符的完整
 * 域名，所以只会换掉域名那一处——路径里恰好含有域名字样、或域名只是另一个域名的后缀时都不动。
 * 阅读器图片模块直接复用本函数。
 * @param {string} url
 * @param {string} from  images.hosts[0]
 * @param {string} to    images.hosts[1]
 */
export function swapHost(url, from, to) {
  return url.replace(`//${from}/`, `//${to}/`);
}
