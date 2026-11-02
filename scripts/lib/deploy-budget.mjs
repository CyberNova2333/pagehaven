// 上传前检查目标平台预算；与 check 共用，避免在上传资源后才发现静态站无法部署。
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { TARGET_CAPABILITIES, DEPLOY_CONFIG_FILES } from '@gallery/platform';
import { DEPLOY_PROOF_MAX_BYTES, isDeploymentProofPath } from './deploy-proof.mjs';

export async function inspectDeploymentFiles(distDir) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(directory, name);
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) throw new Error('部署目录不能包含符号链接或目录联接');
      if (entry.isDirectory()) await walk(absolute, path);
      else if (entry.isFile()) files.push({ path, size: entry.size });
      else throw new Error('部署目录只能包含普通文件与目录');
    }
  }
  const root = await lstat(distDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('部署根目录必须是普通目录');
  await walk(distDir);
  return files;
}

export function validateDeploymentBudget({ target, config, files }) {
  const limits = TARGET_CAPABILITIES[target];
  if (!limits) return ['未知的部署预算目标'];
  const problems = [];
  const maxFiles = Math.min(config.budgets.max_files, limits.maxFiles ?? Infinity);
  const maxFileBytes = Math.min(config.budgets.max_file_bytes, limits.maxFileBytes ?? Infinity);
  const reservedFiles = limits.deploymentProof ? 1 : 0;
  const count = files.length + reservedFiles;
  if (count > maxFiles) problems.push(`${target} 静态文件 ${count} 个（含 ${reservedFiles} 个部署验证预留）超过上限 ${maxFiles}`);
  let total = reservedFiles * DEPLOY_PROOF_MAX_BYTES;
  if (reservedFiles && DEPLOY_PROOF_MAX_BYTES > maxFileBytes) problems.push('单文件预算不足以预留部署验证文件');
  for (const file of files) {
    if (DEPLOY_CONFIG_FILES.includes(file.path.split('/').at(-1))) problems.push('部署控制文件不能放入公开静态目录');
    if (isDeploymentProofPath(file.path)) problems.push('业务静态目录不能包含部署验证保留路径');
    if (!Number.isSafeInteger(file.size) || file.size < 0) return ['部署文件尺寸无效'];
    total += file.size;
    if (file.size > maxFileBytes) problems.push(`${target} 存在单文件超过 ${maxFileBytes} 字节`);
  }
  if (!Number.isSafeInteger(total)) problems.push('部署总大小超出可校验范围');
  if (limits.maxTotalBytes != null && total > limits.maxTotalBytes) {
    problems.push(`${target} 静态文件总大小 ${total} 字节超过上限 ${limits.maxTotalBytes}`);
  }
  return [...new Set(problems)];
}
