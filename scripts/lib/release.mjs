// 上传与启用分开：已部署页面绑定自己的库，共享指针只在整次生产部署成功后移动。
import { createHash } from 'node:crypto';
import { DEPLOY_TARGETS, DEFAULT_RELEASE_TARGETS } from '@gallery/platform';
import { getObject, putObject } from './r2.mjs';

export const RELEASE_STATE_FILE = 'release-state.json';
export const RELEASE_TARGETS = DEPLOY_TARGETS;

const isPlaceholderHost = (host) => !host || /(^|\.)(example\.(com|net|org)|localhost|invalid|test)$/i.test(host);

export function releasePlan({ target = 'none', environment = 'production', domain, imageHosts }) {
  if (!['none', 'all', ...RELEASE_TARGETS].includes(target)) throw new Error('发布目标无效');
  if (!['production', 'preview'].includes(environment)) throw new Error('部署环境只能是 production 或 preview');
  const targets = target === 'all' ? [...DEFAULT_RELEASE_TARGETS] : target === 'none' ? [] : [target];
  if (environment === 'preview' && targets.includes('github')) {
    throw new Error('GitHub Pages 尚未配置独立预览目标：preview 不能选择 github 或 all');
  }
  if (environment === 'production' && targets.length &&
      isPlaceholderHost(domain)) {
    throw new Error('生产发布必须配置正式站点域名，不能使用示例域名');
  }
  if (environment === 'production' && targets.length &&
      (!Array.isArray(imageHosts) || !imageHosts.length || imageHosts.some(isPlaceholderHost))) {
    throw new Error('生产发布必须配置正式图片域名，不能使用示例域名');
  }
  return { target, environment, targets, activate: environment === 'production' && targets.length > 0 };
}

// 手动发布只接收密钥文件地址，凭据仍由 CNB 在需要的任务中通过 imports 注入。
export function validateSecretImports({ publishUrl, deployUrl, target }) {
  for (const [name, value, required] of [
    ['publish_secrets_url', publishUrl, true],
    ['deploy_secrets_url', deployUrl, target !== 'none'],
  ]) {
    if (!value && !required) continue;
    let url;
    try { url = new URL(value); } catch { /* 统一报错，不回显输入中的账号或令牌。 */ }
    if (!url || value.trim() !== value || url.protocol !== 'https:' ||
        url.username || url.password || url.search || url.hash ||
        !/^\/[^\s]+\/-\/blob\/[^/]+\/.+\.(?:ya?ml|json)$/i.test(url.pathname)) {
      throw new Error(`${name} 必须填写 CNB HTTPS 密钥文件地址（/-/blob/<ref>/<file>.yml 或 .json），不能包含登录凭据、查询参数或片段`);
    }
  }
}

// 生成时间不改变发布内容；其余字段全部进入指纹，避免将另一套数据的部署记录混进来。
export function releaseFingerprint(manifest) {
  const { generatedAt: _generatedAt, ...content } = manifest;
  const stable = (value) => Array.isArray(value) ? value.map(stable) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value;
  return createHash('sha256').update(JSON.stringify(stable(content))).digest('hex');
}

export function deploymentReceipt(manifest, target, environment) {
  return { version: manifest.version, fingerprint: releaseFingerprint(manifest), target, environment };
}

export async function prepareRelease({ client, bucket, prefix, manifest, plan }) {
  const state = { ...deploymentReceipt(manifest, plan.target, plan.environment), previous: null, etag: null };
  if (!plan.activate) return state;
  const old = await getObject(client, bucket, `${prefix}manifest.json`);
  if (old && !old.etag) throw new Error('当前版本缺少 ETag，无法安全启用新版本');
  state.previous = old ? old.body.toString('utf8') : null;
  state.etag = old?.etag ?? null;
  return state;
}

export async function activateRelease({ client, bucket, prefix, manifest, plan, state, receipts }) {
  if (!plan.activate) throw new Error('预览或仅上传不能启用生产版本');
  const expected = deploymentReceipt(manifest, plan.target, plan.environment);
  if (!state || Object.keys(expected).some((k) => state[k] !== expected[k])) {
    throw new Error('发布准备记录与当前版本、目标或环境不一致');
  }
  for (const target of plan.targets) {
    const receipt = receipts.find((r) => r.target === target);
    const wanted = deploymentReceipt(manifest, target, plan.environment);
    if (!receipt || Object.keys(wanted).some((k) => receipt[k] !== wanted[k])) {
      throw new Error(`${target} 缺少本版本的成功部署记录，生产指针未更新`);
    }
  }
  const published = await getObject(client, bucket, `${prefix}manifest-${manifest.version}.json`);
  if (!published || releaseFingerprint(JSON.parse(published.body.toString('utf8'))) !== expected.fingerprint) {
    throw new Error('不可变版本清单缺失或与本次构建不同，生产指针未更新');
  }
  const key = `${prefix}manifest.json`;
  try {
    await putObject(client, bucket, key, published.body, {
      contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=300',
      ...(state.etag ? { ifMatch: state.etag } : { ifNoneMatch: '*' }),
    });
  } catch (e) {
    // 请求已到达存储但回应丢失时，重试同一次启用应成功；别人的更新必须保留。
    if (e.status !== 412) throw e;
    const current = await getObject(client, bucket, key);
    if (!current || !current.body.equals(published.body)) throw new Error('准备发布后生产版本已变化，拒绝覆盖；请重新准备并核对部署', { cause: e });
  }
  return published.body;
}
