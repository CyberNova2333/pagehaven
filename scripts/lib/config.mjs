import { readFile } from 'node:fs/promises';
import { parseSiteConfig } from '@gallery/platform';
import { CONFIG_FILE } from './paths.mjs';

/** 读并校验配置；CONFIG_FILE 可指定独立部署或测试配置，默认仍取仓库根文件。 */
export async function loadSiteConfig() {
  return parseSiteConfig(await readFile(process.env.CONFIG_FILE || CONFIG_FILE, 'utf8'));
}
