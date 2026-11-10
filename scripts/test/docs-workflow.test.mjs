import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

const workflow = yaml.load(await readFile(new URL('../../.github/workflows/docs-pages.yml', import.meta.url), 'utf8'));
const checks = yaml.load(await readFile(new URL('../../.github/workflows/checks.yml', import.meta.url), 'utf8'));

test('检查流水线：自动入口限 main push，同时保留手动检查', () => {
  assert.deepEqual(Object.keys(checks.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(checks.on.push, { branches: ['main'] });
});

test('检查流水线：文档安装、moderate 审计与统一测试不能漏掉、跳过或吞错', () => {
  const job = checks.jobs.check;
  assert.equal(job.if, undefined, '检查任务不能条件跳过');
  assert.equal(job['continue-on-error'], undefined, '检查任务失败必须阻断');
  const commands = [
    'pnpm --dir docs-site install --frozen-lockfile',
    'pnpm --dir docs-site audit --audit-level=moderate',
    'pnpm test',
  ];
  let previous = -1;
  for (const command of commands) {
    const matches = job.steps.filter((step) => step.run === command);
    assert.equal(matches.length, 1, `必须有一个独立步骤执行 ${command}，不能追加吞错命令`);
    const index = job.steps.indexOf(matches[0]);
    assert.ok(index > previous, '必须先安装，再审计，最后执行统一测试');
    assert.equal(matches[0].if, undefined, `${command} 不能条件跳过`);
    assert.equal(matches[0]['continue-on-error'], undefined, `${command} 失败必须终止`);
    previous = index;
  }
});

test('文档 Pages：只能由手动事件触发发布', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions.pages, 'write');
  assert.equal(workflow.permissions['id-token'], 'write');
});

test('文档 Pages：独立依赖安装和构建成功后才上传正确产物', () => {
  const build = workflow.jobs.build;
  assert.equal(build['continue-on-error'], undefined);
  const steps = build.steps;
  const setup = steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'));
  assert.equal(setup?.with?.package_json_file, 'docs-site/package.json');
  const install = steps.findIndex((step) => step.run === 'pnpm --dir docs-site install --frozen-lockfile');
  const compile = steps.findIndex((step) => step.run === 'pnpm --dir docs-site run docs:build');
  const upload = steps.findIndex((step) => step.uses?.startsWith('actions/upload-pages-artifact@'));
  assert.ok(install >= 0 && install < compile && compile < upload, '必须按安装、构建、上传顺序执行，不吞掉失败');
  for (const index of [install, compile, upload]) {
    assert.equal(steps[index].if, undefined, '关键步骤不能条件跳过');
    assert.equal(steps[index]['continue-on-error'], undefined, '关键步骤失败必须终止');
  }
  assert.equal(steps[upload].with.path, 'docs-site/.vitepress/dist');
});

test('文档 Pages：部署依赖构建成功，环境 URL 引用真实部署步骤输出', () => {
  const deploy = workflow.jobs.deploy;
  assert.equal(deploy.needs, 'build');
  assert.equal(deploy.if, undefined, '使用默认 success 条件，不能在构建失败后继续部署');
  const step = deploy.steps.find((item) => item.uses?.startsWith('actions/deploy-pages@'));
  assert.equal(step?.id, 'deployment');
  assert.equal(deploy.environment.name, 'github-pages');
  assert.equal(deploy.environment.url, '${{ steps.deployment.outputs.page_url }}');
});
