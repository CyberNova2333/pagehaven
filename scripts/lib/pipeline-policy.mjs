// 自动检查不能发布；匹配所有 deploy 名称，新增目标不需要再维护正则白名单。
export function hasDeploymentCommand(text) {
  return /publish:r2|release:activate|deploy:|scripts[\\/]deploy\.mjs|(?:wrangler|esa-cli|edgeone)\b[^\n]*\bdeploy\b/.test(text);
}

// 文档是独立 npm 项目。检查入口必须先安装和审计它，再运行包含文档构建回归的统一测试。
// 只接受仓库约定的独立命令阶段，避免条件跳过、吞掉失败或合并 shell 命令导致假绿。
export function checkDocumentationPipelines(document) {
  // CNB 除 if 外还有按变更/新分支执行和源分支更新时终止的条件；stage 另可直接跳过。
  const pipelineConditions = ['if', 'ifModify', 'ifNewBranch', 'breakIfModify'];
  const stageConditions = [...pipelineConditions, 'skipIfModify'];
  const commands = [
    'npm ci',
    'npm --prefix docs-site ci',
    'cd docs-site && npm audit --include=dev --audit-level=moderate',
    'npm test',
  ];
  const problems = [];
  for (const event of ['push', 'web_trigger_check']) {
    const label = `main.${event}`;
    const pipelines = document?.main?.[event];
    if (!Array.isArray(pipelines) || pipelines.length !== 1) {
      problems.push(`${label}：文档验证需要恰好一条检查流水线`);
      continue;
    }
    const pipeline = pipelines[0];
    if (pipelineConditions.some((key) => pipeline?.[key] !== undefined) || pipeline?.allowFailure) {
      problems.push(`${label}：检查流水线不能条件跳过或允许失败`);
    }
    const stages = Array.isArray(pipeline?.stages) ? pipeline.stages : [];
    let previous = -1;
    for (const command of commands) {
      const index = stages.findIndex((stage) => stage?.script === command);
      if (index < 0) {
        problems.push(`${label}：缺少独立阶段 \`${command}\``);
        continue;
      }
      if (stageConditions.some((key) => stages[index][key] !== undefined) || stages[index].allowFailure) {
        problems.push(`${label}：\`${command}\` 不能条件跳过或允许失败`);
      }
      if (index <= previous) {
        problems.push(`${label}：须按业务依赖、文档依赖、文档审计、统一测试的顺序执行`);
      }
      previous = index;
    }
  }
  return problems;
}
