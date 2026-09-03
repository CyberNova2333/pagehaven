#!/usr/bin/env node
// build:config —— site.config.yaml → packages/platform/generated/{_headers,_redirects,edgeone.json}
//                 以及站点读的 packages/site/src/generated/site-config.json。
// 生成物入库（前者）是为了让 check 能比对同步；后者不入库，每次构建重生成。
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { generateAll } from '@gallery/platform';
import { loadSiteConfig } from './lib/config.mjs';
import { PLATFORM_GENERATED_DIR, ROOT } from './lib/paths.mjs';
import { writeSiteConfigJson } from './lib/site-generated.mjs';
import { step, ok } from './lib/log.mjs';

step('build:config');
const config = await loadSiteConfig();
await mkdir(PLATFORM_GENERATED_DIR, { recursive: true });
for (const [name, content] of Object.entries(await generateAll(config))) {
  const p = join(PLATFORM_GENERATED_DIR, name);
  await writeFile(p, content);
  ok(relative(ROOT, p));
}
ok(relative(ROOT, await writeSiteConfigJson(config)));
