// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BUILD_WORK_DIR, DIST_DIR, SITE_DIR, SITE_GENERATED_DIR } from './paths.mjs';

const require = createRequire(join(SITE_DIR, 'package.json'));
const pkg = require.resolve('astro/package.json');
const astro = join(dirname(pkg), require(pkg).bin.astro);

// Astro 从项目根定位 glob、.astro 以及 Vite 缓存。独立任务只复制小型前端源码，
// 生成数据、公共资源与已安装依赖均按目录引用，各任务自行持有可写缓存。
export async function buildAstro({ work = BUILD_WORK_DIR, generated = SITE_GENERATED_DIR, out = DIST_DIR, stdio = 'inherit' } = {}) {
  const root = work ? await mkdtemp(join(work, 'astro-')) : SITE_DIR;
  try {
    if (work) {
      for (const file of ['package.json', 'tsconfig.json', 'astro.config.mjs']) {
        await cp(join(SITE_DIR, file), join(root, file));
      }
      const source = join(SITE_DIR, 'src');
      await cp(source, join(root, 'src'), { recursive: true, filter: (path) => path !== join(source, 'generated') });
      await symlink(generated, join(root, 'src', 'generated'), 'junction');
      await symlink(join(SITE_DIR, 'public'), join(root, 'public'), 'junction');
      const { dependencies } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      for (const dep of Object.keys(dependencies)) {
        const dest = join(root, 'node_modules', dep);
        await mkdir(dirname(dest), { recursive: true });
        await symlink(join(SITE_DIR, 'node_modules', dep), dest, 'junction');
      }
    }
    return spawnSync(process.execPath, [astro, 'build', '--outDir', out], { cwd: root, encoding: 'utf8', stdio });
  } finally {
    if (work) await rm(root, { recursive: true, force: true });
  }
}
