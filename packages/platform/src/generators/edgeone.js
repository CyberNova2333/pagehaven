// EdgeOne Pages 的 edgeone.json 生成器。
//
// 上限来自平台文档（ARCHITECTURE §3 三平台矩阵）：headers ≤ 30 条、redirects/rewrites ≤ 100 条。
// 超线在生成期就报错，而不是等部署时被平台拒绝——那时 release.yml 已经跑到一半。
// JSON 放不下注释，所以「这是生成物」只能靠 check 守卫与文件所在目录的 README 说明。
export const EDGEONE_MAX_HEADERS = 30;
export const EDGEONE_MAX_REDIRECTS = 100;

/** @param {import('../site-config.js').SiteConfig} config */
export function buildEdgeoneConfig(config) {
  if (config.headers.length > EDGEONE_MAX_HEADERS) {
    throw new Error(`edgeone.json 最多 ${EDGEONE_MAX_HEADERS} 条 headers 规则，现有 ${config.headers.length}`);
  }
  if (config.redirects.length > EDGEONE_MAX_REDIRECTS) {
    throw new Error(`edgeone.json 最多 ${EDGEONE_MAX_REDIRECTS} 条 redirects，现有 ${config.redirects.length}`);
  }
  return {
    headers: config.headers.map((rule) => ({
      source: rule.path,
      headers: Object.entries(rule.headers).map(([key, value]) => ({ key, value })),
    })),
    redirects: config.redirects.map((r) => ({ source: r.from, destination: r.to, statusCode: r.status })),
  };
}

/** @param {import('../site-config.js').SiteConfig} config */
export function renderEdgeoneConfig(config) {
  return JSON.stringify(buildEdgeoneConfig(config), null, 2) + '\n';
}
