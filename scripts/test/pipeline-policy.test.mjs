import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { DEPLOY_TARGETS, DEFAULT_RELEASE_TARGETS } from '@gallery/platform';
import { hasDeploymentCommand } from '../lib/pipeline-policy.mjs';

test('自动检查拒绝新旧部署目标、未来目标及直接 CLI，不误拒绝业务构建测试', () => {
  for (const command of [...DEPLOY_TARGETS, 'future-platform'].map((target) => `npm run deploy:${target}`)
    .concat(['node scripts/deploy.mjs workers', 'npx wrangler deploy', 'esa-cli deploy', 'edgeone makers deploy dist', 'npm run release:activate'])) {
    assert.equal(hasDeploymentCommand(command), true, command);
  }
  assert.equal(hasDeploymentCommand('npm run build && npm run check && npm test'), false);
});

test('手动发布入口覆盖注册目标，all 只发布四平台且保留旧 Pages 独立入口', async () => {
  const root = new URL('../../', import.meta.url);
  const pipeline = yaml.load(await readFile(new URL('.cnb.yml', root), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const release = pipeline.main.web_trigger_release[0];
  for (const target of DEPLOY_TARGETS) {
    const command = `npm run deploy:${target}`;
    const stage = release.stages.find((item) => item.script === command);
    assert.ok(stage, target);
    assert.equal(pkg.scripts[`deploy:${target}`], `node scripts/deploy.mjs ${target}`);
    assert.equal(stage.if.includes('"all"'), DEFAULT_RELEASE_TARGETS.includes(target), target);
  }
  assert.equal(hasDeploymentCommand(JSON.stringify(pipeline.main.push)), false);
  const check = release.stages.findIndex((stage) => stage.script === 'npm run check');
  const upload = release.stages.findIndex((stage) => stage.script === 'npm run publish:r2');
  assert.ok(check >= 0 && check < upload, '平台预算必须在上传前检查');
});
