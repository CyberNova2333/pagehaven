// Workers 默认使用 workers.dev，名称必须是有效 DNS 标签；仓库继续只接受小写名称。
// 计划与配置生成共用此处，避免预检通过后才由 CLI 拒绝。
export function isDeploymentName(target, name) {
  if (typeof name !== 'string') return false;
  if (target === 'workers') return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
  if (target === 'esa') return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name);
  return false;
}
