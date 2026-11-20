// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { DEPLOY_TARGETS, DEFAULT_RELEASE_TARGETS } from '@gallery/platform';

export const MAIN_ONLY = "github.ref == 'refs/heads/main'";
export const PRODUCTION_ONLY = "env.DEPLOY_ENV == 'production' && env.DEPLOY_TARGET != 'none'";
export const SECRET_COMMAND = 'node scripts/ci/run-with-secrets.mjs';
const REQUIRED_WORKFLOWS = ['checks.yml', 'release.yml', 'archive.yml', 'docs-pages.yml'];

export function expression(value) {
  return String(value ?? '').trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
}

export function hasDeploymentCommand(text) {
  return /publish:r2|release:activate|deploy:|scripts[\\/]deploy\.mjs|(?:wrangler|esa-cli|edgeone)\b[^\n]*\bdeploy\b|actions\/deploy-pages@/.test(text);
}

function sameValues(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    [...actual].sort().every((value, i) => value === [...expected].sort()[i]);
}

function orderedSteps(steps, commands, label, problems) {
  let previous = -1;
  for (const command of commands) {
    const index = steps.findIndex((step, i) => i > previous && step?.run === command);
    if (index < 0) {
      problems.push(label + '：缺少或顺序错误的独立步骤 ' + command);
      continue;
    }
    if (steps[index].if !== undefined || steps[index]['continue-on-error'] !== undefined) {
      problems.push(label + '：' + command + ' 不能条件跳过或继续失败');
    }
    previous = index;
  }
}

function checkAutomaticWorkflow(workflow, problems) {
  const label = 'checks.yml';
  const push = workflow.on?.push;
  if (!push || !sameValues(Object.keys(push), ['branches']) || !sameValues(push.branches, ['main'])) {
    problems.push(label + '：自动检查必须覆盖 main 的全部 push，不能限制路径或增加其他分支、标签');
  }
  const jobs = workflow.jobs ?? {};
  if (!sameValues(Object.keys(jobs), ['check'])) problems.push(label + '：必须有且仅有 check 检查任务');
  const job = jobs.check;
  if (!job || job.if !== undefined || job['continue-on-error'] !== undefined || job.needs !== undefined || job.uses !== undefined) {
    problems.push(label + '：检查任务不能缺失、条件跳过、允许失败或转交其他工作流');
  }
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  orderedSteps(steps, [
    'pnpm install --frozen-lockfile',
    'pnpm --dir docs-site install --frozen-lockfile',
    'pnpm --dir docs-site audit --audit-level=moderate',
    'pnpm run check', 'pnpm test', 'pnpm run build', 'pnpm run check',
  ], label, problems);
  if (hasDeploymentCommand(JSON.stringify(jobs))) problems.push(label + '：自动检查中禁止发布或部署');
  if (/secrets\s*[.[]/.test(JSON.stringify(workflow))) problems.push(label + '：自动检查不能读取发布密钥');
  for (const step of steps) {
    if (step.uses && !/^(?:actions\/(?:checkout|setup-node)|pnpm\/action-setup)@/.test(step.uses)) {
      problems.push(label + '：自动检查包含未核对的 Action ' + step.uses);
    }
  }
}

function checkReleaseWorkflow(workflow, problems) {
  const label = 'release.yml';
  const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
  if (!sameValues(inputs.target?.options, ['none', 'all', ...DEPLOY_TARGETS]) || inputs.target?.type !== 'choice') {
    problems.push(label + '：手动发布选项必须覆盖全部注册目标、none 与 all');
  }
  if (!sameValues(inputs.deploy_env?.options, ['production', 'preview']) || inputs.deploy_env?.type !== 'choice') {
    problems.push(label + '：发布环境必须显式选择 production 或 preview');
  }
  const steps = workflow.jobs?.release?.steps ?? [];
  const deployIndexes = [];
  for (const target of DEPLOY_TARGETS) {
    const command = SECRET_COMMAND + ' DEPLOY_SECRETS_YML pnpm run deploy:' + target;
    const matches = steps.filter((step) => step.run === command);
    const expected = "env.DEPLOY_TARGET == '" + target + "'" + (DEFAULT_RELEASE_TARGETS.includes(target) ? " || env.DEPLOY_TARGET == 'all'" : '');
    if (matches.length !== 1 || expression(matches[0]?.if) !== expected || matches[0]?.['continue-on-error'] !== undefined) {
      problems.push(label + '：' + target + ' 部署步骤缺失、允许失败或选择条件错误');
    }
    if (matches[0]) deployIndexes.push(steps.indexOf(matches[0]));
  }
  const beforeUpload = [
    'pnpm run build', 'pnpm run check',
    SECRET_COMMAND + ' PUBLISH_SECRETS_YML pnpm run verify:manifest',
    SECRET_COMMAND + ' PUBLISH_SECRETS_YML pnpm run release:prepare',
    SECRET_COMMAND + ' PUBLISH_SECRETS_YML pnpm run publish:r2',
  ];
  orderedSteps(steps, beforeUpload, label, problems);
  const upload = steps.findIndex((step) => step.run === beforeUpload.at(-1));
  const activation = steps.findIndex((step) => step.run === SECRET_COMMAND + ' PUBLISH_SECRETS_YML pnpm run release:activate');
  const status = steps.findIndex((step) => step.run === SECRET_COMMAND + ' PUBLISH_SECRETS_YML pnpm run status');
  if (deployIndexes.some((index) => index <= upload || index >= activation) || activation < 0 || status <= activation) {
    problems.push(label + '：必须先上传，再完成目标部署，然后启用生产版本并生成状态');
  }
  for (const index of [activation, status]) {
    if (index < 0 || expression(steps[index]?.if) !== PRODUCTION_ONLY || steps[index]?.['continue-on-error'] !== undefined) {
      problems.push(label + '：生产启用与状态步骤必须成功阻断，且排除预览和仅上传');
    }
  }
}

// 遍历实际工作流目录，新增自动入口同样受约束；不再从另一套配置推断 GitHub 行为。
export function checkGithubWorkflows(workflows) {
  const problems = [];
  for (const name of REQUIRED_WORKFLOWS) {
    if (!workflows[name]) problems.push(name + '：缺少必需工作流');
  }
  for (const [name, workflow] of Object.entries(workflows)) {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      problems.push(name + '：工作流必须是对象');
      continue;
    }
    const events = workflow.on && typeof workflow.on === 'object' && !Array.isArray(workflow.on) ? Object.keys(workflow.on) : [];
    if (!sameValues(events, name === 'checks.yml' ? ['push', 'workflow_dispatch'] : ['workflow_dispatch'])) {
      problems.push(name + '：只允许手动入口，自动 main push 检查只能由 checks.yml 承担');
    }
    if (name === 'checks.yml') {
      checkAutomaticWorkflow(workflow, problems);
      continue;
    }
    const jobs = workflow.jobs;
    if (!jobs || typeof jobs !== 'object' || !Object.keys(jobs).length) {
      problems.push(name + '：缺少可执行任务');
      continue;
    }
    if (!workflow.concurrency?.group || workflow.concurrency?.['cancel-in-progress'] !== false) {
      problems.push(name + '：手动操作必须串行运行，不能取消已经进行的发布或归档');
    }
    for (const [id, job] of Object.entries(jobs)) {
      if (expression(job?.if) !== MAIN_ONLY) problems.push(name + '/' + id + '：手动操作必须限制在 main');
      if (job?.['continue-on-error'] !== undefined || job?.uses !== undefined) problems.push(name + '/' + id + '：不能忽略任务失败或转交未核对的工作流');
      for (const step of job?.steps ?? []) {
        if (step.uses?.startsWith('actions/checkout@') && step.with?.ref !== '${{ github.sha }}') {
          problems.push(name + '/' + id + '：检出必须固定到触发 SHA，不能随 main 后续移动');
        }
      }
    }
    if (name === 'release.yml') checkReleaseWorkflow(workflow, problems);
  }
  return problems;
}
