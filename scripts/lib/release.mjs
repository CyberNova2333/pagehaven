// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 上传与启用分开：已部署页面绑定自己的库，共享指针只在整次生产部署成功后移动。
import { createHash } from 'node:crypto';
import { DEPLOY_TARGETS, DEFAULT_RELEASE_TARGETS } from '@gallery/platform';
import { R2_ENV_KEYS, getObject, putObject } from './r2.mjs';
import { requiredEnv, planDeployCommand } from './deploy-plan.mjs';

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

// 预检只核对当前目标所需的直接环境变量，不执行网络请求，也不在报错中回显凭据值。
export function validateReleaseSecrets({ env = process.env, plan, config } = {}) {
  const missingPublish = R2_ENV_KEYS.filter((key) => !env[key]?.trim());
  if (missingPublish.length) throw new Error(`缺少对象存储发布环境变量：${missingPublish.join('、')}`);
  for (const target of plan.targets) {
    const keys = target === 'github' ? ['GITHUB_PAGES_REPO', 'GITHUB_PAGES_TOKEN'] : requiredEnv(target);
    const missing = keys.filter((key) => !env[key]?.trim());
    if (missing.length) throw new Error(`缺少 ${target} 部署环境变量：${missing.join('、')}`);
    if (target !== 'github') {
      const command = planDeployCommand({ target, config, env: { ...env, DEPLOY_ENV: plan.environment }, distDir: 'dist' });
      if (!command.ok) throw new Error(`${target} 部署配置无效：${command.problems.join('；')}`);
    }
  }
  const hasSigningKey = Boolean(env.RELEASE_SIGNING_KEY?.trim()) || env.RELEASE_SIGNING_KEY_PRESENT === 'true';
  if ((plan.activate || plan.targets.includes('github')) && !hasSigningKey) {
    throw new Error('生产发布缺少 RELEASE_SIGNING_KEY');
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
