import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { DEPLOY_TARGETS, DEFAULT_RELEASE_TARGETS } from '@gallery/platform';
import { hasDeploymentCommand, checkDocumentationPipelines } from '../lib/pipeline-policy.mjs';

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

test('自动与手动检查都安装和审计文档依赖后再运行统一测试', async () => {
  const pipeline = yaml.load(await readFile(new URL('../../.cnb.yml', import.meta.url), 'utf8'));
  assert.deepEqual(checkDocumentationPipelines(pipeline), []);
  for (const event of ['push', 'web_trigger_check']) {
    assert.equal(hasDeploymentCommand(JSON.stringify(pipeline.main[event])), false);
  }
});

test('文档检查缺失、跳过、吞失败或顺序颠倒时拒绝假绿', async (t) => {
  const pipeline = yaml.load(await readFile(new URL('../../.cnb.yml', import.meta.url), 'utf8'));
  for (const event of ['push', 'web_trigger_check']) {
    for (const command of ['npm --prefix docs-site ci', 'cd docs-site && npm audit --include=dev --audit-level=moderate', 'npm test']) {
      for (const mode of ['missing', 'conditional', 'ifModify', 'ifNewBranch', 'breakIfModify', 'skipIfModify', 'allowFailure', 'swallowed']) {
        await t.test(`${event} ${mode} ${command}`, () => {
          const candidate = structuredClone(pipeline);
          const stages = candidate.main[event][0].stages;
          const index = stages.findIndex((stage) => stage.script === command);
          assert.notEqual(index, -1);
          if (mode === 'missing') stages.splice(index, 1);
          if (mode === 'conditional') stages[index].if = 'false';
          if (mode === 'ifModify') stages[index].ifModify = ['docs-site/**'];
          if (['ifNewBranch', 'breakIfModify', 'skipIfModify'].includes(mode)) stages[index][mode] = true;
          if (mode === 'allowFailure') stages[index].allowFailure = true;
          if (mode === 'swallowed') stages[index].script += ' || true';
          assert.ok(checkDocumentationPipelines(candidate).some((problem) => problem.startsWith(`main.${event}：`)));
        });
      }
    }
    await t.test(`${event} 审计在安装之前`, () => {
      const candidate = structuredClone(pipeline);
      const stages = candidate.main[event][0].stages;
      const install = stages.findIndex((stage) => stage.script === 'npm --prefix docs-site ci');
      const audit = stages.findIndex((stage) => stage.script === 'cd docs-site && npm audit --include=dev --audit-level=moderate');
      [stages[install], stages[audit]] = [stages[audit], stages[install]];
      assert.ok(checkDocumentationPipelines(candidate).some((problem) => problem.includes('顺序执行')));
    });
    for (const [key, value] of Object.entries({ if: 'false', ifModify: ['docs-site/**'], ifNewBranch: true, breakIfModify: true })) {
      await t.test(`${event} 整条检查入口设置 ${key}`, () => {
        const candidate = structuredClone(pipeline);
        candidate.main[event][0][key] = value;
        assert.ok(checkDocumentationPipelines(candidate).some((problem) => problem.includes('检查流水线不能条件跳过')));
      });
    }
  }
  const candidate = structuredClone(pipeline);
  delete candidate.main.web_trigger_check;
  assert.ok(checkDocumentationPipelines(candidate).some((problem) => problem.startsWith('main.web_trigger_check：')));
});
