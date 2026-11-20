import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import yaml from 'js-yaml';
import { DEPLOY_TARGETS } from '@gallery/platform';
import { checkGithubWorkflows, hasDeploymentCommand, MAIN_ONLY } from '../lib/pipeline-policy.mjs';

const root = new URL('../../', import.meta.url);
const directory = new URL('.github/workflows/', root);
const workflows = Object.fromEntries(await Promise.all((await readdir(directory)).filter((name) => /\.ya?ml$/.test(name))
  .map(async (name) => [name, yaml.load(await readFile(new URL(name, directory), 'utf8'))])));

test('实际 GitHub 工作流通过守卫，注册部署命令与按钮同步', async () => {
  assert.deepEqual(checkGithubWorkflows(workflows), []);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const target of DEPLOY_TARGETS) assert.equal(pkg.scripts['deploy:' + target], 'node scripts/deploy.mjs ' + target);
});

test('发布识别覆盖当前、未来目标与 Action，不误拒绝业务构建测试', () => {
  for (const command of [...DEPLOY_TARGETS, 'future-platform'].map((target) => 'pnpm run deploy:' + target)
    .concat(['node scripts/deploy.mjs workers', 'pnpm dlx wrangler deploy', 'esa-cli deploy', 'edgeone makers deploy dist',
      'pnpm run publish:r2', 'pnpm run release:activate', 'actions/deploy-pages@v4'])) {
    assert.equal(hasDeploymentCommand(command), true, command);
  }
  assert.equal(hasDeploymentCommand('pnpm run build && pnpm run check && pnpm test'), false);
});

test('真实工作流的自动入口越界、附加文件和不完整配置均被拒绝', async (t) => {
  const cases = {
    '缺少检查工作流': (candidate) => { delete candidate['checks.yml']; },
    '其他分支自动检查': (candidate) => { candidate['checks.yml'].on.push.branches.push('topic'); },
    '检查只看文档路径': (candidate) => { candidate['checks.yml'].on.push.paths = ['docs-site/**']; },
    '检查被改为 reusable workflow': (candidate) => { candidate['checks.yml'].on = { workflow_call: {} }; },
    '定时发布': (candidate) => { candidate['release.yml'].on.schedule = [{ cron: '* * * * *' }]; },
    '新增自动部署工作流': (candidate) => { candidate['extra.yaml'] = { on: { push: {} }, jobs: {} }; },
    '发布任务无 main 限制': (candidate) => { delete candidate['release.yml'].jobs.release.if; },
    '发布检出移动分支': (candidate) => { candidate['release.yml'].jobs.release.steps[0].with.ref = 'main'; },
    '归档取消在途执行': (candidate) => { candidate['archive.yml'].concurrency['cancel-in-progress'] = true; },
    '自动检查增加部署步骤': (candidate) => { candidate['checks.yml'].jobs.check.steps.push({ run: 'pnpm run deploy:workers' }); },
    '自动检查使用部署 Action': (candidate) => { candidate['checks.yml'].jobs.check.steps.push({ uses: 'actions/deploy-pages@v4' }); },
    '自动检查读取发布秘密': (candidate) => { candidate['checks.yml'].env = { SECRET: 'secrets.PUBLISH_SECRETS_YML' }; },
    '检查任务条件跳过': (candidate) => { candidate['checks.yml'].jobs.check.if = MAIN_ONLY; },
    '检查任务允许失败': (candidate) => { candidate['checks.yml'].jobs.check['continue-on-error'] = true; },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, () => {
      const candidate = structuredClone(workflows);
      change(candidate);
      assert.ok(checkGithubWorkflows(candidate).length, name);
    });
  }
});

test('检查和上传之前的关键步骤必须独立、顺序执行并阻断失败', async (t) => {
  for (const file of ['checks.yml', 'release.yml']) {
    const id = file === 'checks.yml' ? 'check' : 'release';
    const commands = file === 'checks.yml'
      ? ['pnpm install --frozen-lockfile', 'pnpm --dir docs-site install --frozen-lockfile', 'pnpm --dir docs-site audit --audit-level=moderate', 'pnpm test']
      : ['pnpm run build', 'pnpm run check', 'node scripts/ci/run-with-secrets.mjs PUBLISH_SECRETS_YML pnpm run publish:r2'];
    for (const command of commands) {
      for (const mode of ['missing', 'skip', 'continue', 'swallow', 'reorder']) {
        await t.test(file + ' / ' + command + ' / ' + mode, () => {
          const candidate = structuredClone(workflows);
          const steps = candidate[file].jobs[id].steps;
          const index = steps.findIndex((step) => step.run === command);
          assert.ok(index >= 0);
          if (mode === 'missing') steps.splice(index, 1);
          if (mode === 'skip') steps[index].if = 'false';
          if (mode === 'continue') steps[index]['continue-on-error'] = true;
          if (mode === 'swallow') steps[index].run += ' || true';
          if (mode === 'reorder') steps.push(...steps.splice(index, 1));
          assert.ok(checkGithubWorkflows(candidate).length, mode);
        });
      }
    }
  }
});

test('发布目标、上传部署启用顺序及预览隔离不能被工作流变更绕过', async (t) => {
  const cases = {
    '缺少目标选项': (w) => { w.on.workflow_dispatch.inputs.target.options.pop(); },
    '重复目标': (w) => { w.on.workflow_dispatch.inputs.target.options.push('all'); },
    '把旧 Pages 纳入 all': (w) => { w.jobs.release.steps.find((s) => s.name === 'deploy:cloudflare').if += " || env.DEPLOY_TARGET == 'all'"; },
    '部署吞错': (w) => { w.jobs.release.steps.find((s) => s.name === 'deploy:workers')['continue-on-error'] = true; },
    '预览也启用生产': (w) => { delete w.jobs.release.steps.find((s) => s.run?.endsWith('pnpm run release:activate')).if; },
    '跳过部署直接启用': (w) => {
      const steps = w.jobs.release.steps;
      const at = steps.findIndex((s) => s.run?.endsWith('pnpm run release:activate'));
      steps.unshift(...steps.splice(at, 1));
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, () => {
      const candidate = structuredClone(workflows);
      change(candidate['release.yml']);
      assert.ok(checkGithubWorkflows(candidate).length, name);
    });
  }
});
