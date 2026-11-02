// 自动检查不能发布；匹配所有 deploy 名称，新增目标不需要再维护正则白名单。
export function hasDeploymentCommand(text) {
  return /publish:r2|release:activate|deploy:|scripts[\\/]deploy\.mjs|(?:wrangler|esa-cli|edgeone)\b[^\n]*\bdeploy\b/.test(text);
}
