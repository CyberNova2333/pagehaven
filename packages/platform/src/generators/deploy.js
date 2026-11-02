// 部署控制文件不属于公开静态资源。build:config 生成不含项目标识的模板；
// deploy 在临时目录中用已校验 secrets 注入 name 和静态产物的绝对路径。
// 默认路径相对 packages/platform/generated/，不依赖执行命令时的工作目录。
import { isDeploymentName } from '../deploy-name.js';

const DEFAULT_ASSETS_DIRECTORY = '../../../dist';

function deployInputs(directory, name, target) {
  if (typeof directory !== 'string' || !directory || directory !== directory.trim() ||
      [...directory].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) {
    throw new Error('静态产物目录必须是无控制字符的非空路径');
  }
  if (name !== undefined && !isDeploymentName(target, name)) {
    throw new Error(`${target} 项目标识格式无效`);
  }
  return name === undefined ? {} : { name };
}

/**
 * @param {import('../site-config.js').SiteConfig} config
 * @param {{directory?: string, name?: string}} options
 */
export function renderWorkersDeployConfig(config, { directory = DEFAULT_ASSETS_DIRECTORY, name } = {}) {
  return JSON.stringify({
    ...deployInputs(directory, name, 'workers'),
    compatibility_date: config.deploy.workers.compatibility_date,
    assets: {
      directory,
      html_handling: 'auto-trailing-slash',
      not_found_handling: '404-page',
    },
  }, null, 2) + '\n';
}

/**
 * @param {import('../site-config.js').SiteConfig} _config
 * @param {{directory?: string, name?: string}} options
 */
export function renderEsaDeployConfig(_config, { directory = DEFAULT_ASSETS_DIRECTORY, name } = {}) {
  return JSON.stringify({
    ...deployInputs(directory, name, 'esa'),
    installCommand: '',
    buildCommand: '',
    assets: { directory, notFoundStrategy: '404Page' },
  }, null, 2) + '\n';
}
