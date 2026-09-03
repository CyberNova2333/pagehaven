// 把校验过的 site.config.yaml 写成 JSON 交给站点。
//
// 站点代码（packages/site）不许 import Node 内置模块（铁律 1），所以读 YAML 这件事
// 在这里做，站点只 import 一份 JSON。目录不入库（.gitignore），每次构建重生成。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_GENERATED_DIR } from './paths.mjs';

export const SITE_CONFIG_JSON = join(SITE_GENERATED_DIR, 'site-config.json');

/** @param {import('@gallery/platform').SiteConfig} config */
export async function writeSiteConfigJson(config) {
  await mkdir(SITE_GENERATED_DIR, { recursive: true });
  await writeFile(SITE_CONFIG_JSON, JSON.stringify(config, null, 2) + '\n');
  return SITE_CONFIG_JSON;
}
