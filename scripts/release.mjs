#!/usr/bin/env node
// 手动发布的检查、准备与启用入口；预览和仅上传永远不移动生产指针。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSiteConfig } from './lib/config.mjs';
import { readManifest, resolveVersion } from './lib/manifest.mjs';
import { OUT_DIR } from './lib/paths.mjs';
import { r2ClientFromEnv } from './lib/r2.mjs';
import { MANIFEST_PREVIOUS_FILE } from './lib/seo-push.mjs';
import { releasePlan, validateSecretImports, prepareRelease, activateRelease, RELEASE_STATE_FILE, RELEASE_TARGETS } from './lib/release.mjs';
import { ok, fail, note } from './lib/log.mjs';

const phase = process.argv[2];
try {
  if (!['check', 'prepare', 'activate'].includes(phase)) throw new Error('用法：release.mjs check|prepare|activate');
  const config = await loadSiteConfig();
  const plan = releasePlan({ target: process.env.DEPLOY_TARGET || 'none', environment: process.env.DEPLOY_ENV || 'production', domain: config.site.domain, imageHosts: config.images.hosts });
  if (phase === 'check') {
    resolveVersion();
    if (process.argv.includes('--require-secret-imports')) {
      validateSecretImports({ publishUrl: process.env.publish_secrets_url, deployUrl: process.env.deploy_secrets_url, target: plan.target });
    }
    ok(`发布参数通过：${plan.target} / ${plan.environment}`);
  } else {
    const manifest = await readManifest(OUT_DIR);
    if (!manifest?.db || manifest.version !== resolveVersion()) throw new Error('本次完整构建的检索库清单不存在或版本不一致');
    await mkdir(OUT_DIR, { recursive: true });
    const stateFile = join(OUT_DIR, RELEASE_STATE_FILE);
    const previousFile = join(OUT_DIR, MANIFEST_PREVIOUS_FILE);
    if (phase === 'prepare') {
      // 重试同一目录时，旧部署记录不能证明本次部署已经成功。
      await rm(stateFile, { force: true });
      await rm(previousFile, { force: true });
      for (const target of RELEASE_TARGETS) await rm(join(OUT_DIR, `deployed-${target}.json`), { force: true });
    }
    if (!plan.activate) {
      if (phase === 'activate') throw new Error('预览或仅上传不能启用生产版本');
      note('本次只准备版本化产物，不读取或更新生产指针');
    } else {
      const storage = r2ClientFromEnv();
      if (!storage) throw new Error('缺少发布流程的对象存储凭据');
      const args = { ...storage, prefix: config.db.prefix, manifest, plan };
      if (phase === 'prepare') {
        const state = await prepareRelease(args);
        await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
        if (state.previous !== null) await writeFile(previousFile, state.previous);
        ok('已保存生产版本基线，上传和部署期间不移动指针');
      } else {
        const state = JSON.parse(await readFile(stateFile, 'utf8'));
        const receipts = await Promise.all(plan.targets.map(async (target) => JSON.parse(await readFile(join(OUT_DIR, `deployed-${target}.json`), 'utf8'))));
        await activateRelease({ ...args, state, receipts });
        ok(`生产指针已启用 ${manifest.version}；各站点仍使用各自构建绑定的检索库`);
      }
    }
  }
} catch (e) {
  fail(e.message);
  process.exitCode = 1;
}
