import { readFile } from 'node:fs/promises';
import { parseSiteConfig } from '@gallery/platform';
import { CONFIG_FILE } from './paths.mjs';

/** 读并校验 site.config.yaml。不合法直接抛，信息里列出字段。 */
export async function loadSiteConfig() {
  return parseSiteConfig(await readFile(CONFIG_FILE, 'utf8'));
}
