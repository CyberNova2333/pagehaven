// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { readFile } from 'node:fs/promises';
import { parseSiteConfig } from '@gallery/platform';
import { CONFIG_FILE } from './paths.mjs';

/** 读并校验配置；CONFIG_FILE 可指定独立部署或测试配置，默认仍取仓库根文件。 */
export async function loadSiteConfig() {
  return parseSiteConfig(await readFile(process.env.CONFIG_FILE || CONFIG_FILE, 'utf8'));
}
