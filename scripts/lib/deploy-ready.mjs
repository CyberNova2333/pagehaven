// CLI 成功只表示提交成功；目标站点必须返回仅交给本次目标上传的随机标记。
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';
import { assertDeploymentProof, deploymentProofFile, matchesDeploymentProof } from './deploy-proof.mjs';
import { Agent, fetch as undiciFetch } from 'undici';

// ESA 的 staging 通过官方测试 IP + 原域名访问；仅替换此验证连接的 DNS，
// 保留 URL/Host/SNI 和 TLS 证书检查，不修改维护者或 CI 的 hosts 文件。
// fetch 与连接器必须来自同一包；Node 内置 fetch 的 dispatcher 接口可能比当前依赖旧。
export function createStagingVerifier(address, { fetchImpl = undiciFetch, agentFactory = (options) => new Agent(options) } = {}) {
  const family = isIP(address);
  if (!family) throw new Error('ESA_PREVIEW_IP 必须是控制台提供的测试环境 IP');
  const dispatcher = agentFactory({ connect: { lookup(_hostname, options, callback) {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  } } });
  return { fetchImpl: (url, options) => fetchImpl(url, { ...options, dispatcher }), close: () => dispatcher.close() };
}

export function deploymentRoot(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('部署验证地址必须是 HTTPS 根地址'); }
  if (typeof value !== 'string' || !/^https:\/\//.test(value) || /[\s\\]/.test(value) || value !== value.trim() || url.protocol !== 'https:' ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port) {
    throw new Error('部署验证地址必须是无凭据、端口、查询和片段的 HTTPS 根地址');
  }
  return url.origin;
}

async function readMarker(response) {
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {});
    throw new Error('目标尚未返回成功响应');
  }
  if (!response.body?.getReader) throw new Error('目标未返回可读取的发布标记');
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) throw new Error('目标发布标记超过大小限制');
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function waitForDeployment({ url, receipt, proof, fetchImpl = fetch, attempts = 12, intervalMs = 5000, timeoutMs = 10000, sleep = delay }) {
  const origin = deploymentRoot(url);
  assertDeploymentProof(proof, receipt);
  const proofUrl = `${origin}/${deploymentProofFile(proof)}`;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 30 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 10000) throw new Error('部署验证重试参数无效');
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(proofUrl, {
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Cache-Control': 'no-cache' },
      });
      const marker = await readMarker(response);
      if (matchesDeploymentProof(marker, proof)) return;
    } catch { /* 不回显响应正文、地址或第三方异常，避免泄露预览身份或凭据。 */ }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error('目标站点未确认本次部署随机值、目标、版本、指纹和环境，未记录部署成功');
}
