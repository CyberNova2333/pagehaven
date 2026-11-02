// 只交给本次目标上传的随机证明；不包含账号、项目名、地址或凭据。
import { randomBytes } from 'node:crypto';
import { TARGET_CAPABILITIES } from '@gallery/platform';

export const DEPLOY_PROOF_MAX_BYTES = 4096;
const PREFIX = 'pagehaven-deploy-';
const RECEIPT_FIELDS = ['version', 'fingerprint', 'target', 'environment'];

export function isDeploymentProofPath(path) {
  return path.split('/').some((part) => part.startsWith(PREFIX) && part.endsWith('.json'));
}

export function deploymentProofFile(proof) {
  if (!proof || !/^[a-f0-9]{64}$/.test(proof.nonce)) throw new Error('部署验证随机值无效');
  return `${PREFIX}${proof.nonce}.json`;
}

export function createDeploymentProof(receipt) {
  if (!TARGET_CAPABILITIES[receipt.target]?.deploymentProof ||
      typeof receipt.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(receipt.version) ||
      !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !['preview', 'production'].includes(receipt.environment)) {
    throw new Error('部署验证需要有效的版本、指纹、目标与环境');
  }
  const proof = Object.fromEntries(RECEIPT_FIELDS.map((key) => [key, receipt[key]]));
  proof.nonce = randomBytes(32).toString('hex');
  if (Buffer.byteLength(JSON.stringify(proof) + '\n') > DEPLOY_PROOF_MAX_BYTES) {
    throw new Error('部署验证文件超过预留大小');
  }
  return Object.freeze(proof);
}

export function matchesDeploymentProof(marker, proof) {
  return marker != null && [...RECEIPT_FIELDS, 'nonce'].every((key) => marker[key] === proof[key]);
}

export function assertDeploymentProof(proof, receipt) {
  deploymentProofFile(proof);
  if (!TARGET_CAPABILITIES[receipt.target]?.deploymentProof || RECEIPT_FIELDS.some((key) => proof[key] !== receipt[key])) {
    throw new Error('部署验证文件与本次目标不匹配');
  }
}
