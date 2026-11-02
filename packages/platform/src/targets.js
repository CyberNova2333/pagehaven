// 部署目标与静态产物预算的单一注册表。cloudflare 保留为旧 Pages 命令，
// workers 明确指 Workers Static Assets；all 只包含当前四个主要目标。
export const DEPLOY_TARGETS = Object.freeze(['cloudflare', 'edgeone', 'github', 'workers', 'esa']);
export const DEFAULT_RELEASE_TARGETS = Object.freeze(['edgeone', 'esa', 'github', 'workers']);

const baseline = { maxFiles: 18000, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: null };

export const TARGET_CAPABILITIES = Object.freeze({
  cloudflare: Object.freeze({ ...baseline, label: 'Cloudflare Pages', previewSupported: true }),
  edgeone: Object.freeze({ ...baseline, label: 'EdgeOne Makers', previewSupported: true }),
  github: Object.freeze({ ...baseline, label: 'GitHub Pages', previewSupported: false, maxTotalBytes: 1_000_000_000 }),
  workers: Object.freeze({ ...baseline, label: 'Cloudflare Workers', previewSupported: true, deploymentProof: true }),
  // 官方限制是 2000 文件、25 MB/文件、1024 MB 部署包。
  // 文档未定义二进制单位，保守按十进制 MB 预检未压缩产物；CLI 仍负责实际部署包限制。
  esa: Object.freeze({ ...baseline, label: 'ESA Pages', previewSupported: true, deploymentProof: true, maxFiles: 2000, maxTotalBytes: 1_024_000_000 }),
});
