// EdgeOne Pages API 的只读校验（纯函数 + fetch，供 deploy.mjs 在部署前调用）。
//
// 为什么需要这一层：CLI 的 `makers deploy -n` 只按**项目名**解析（源码里 DescribePagesProjects
// 按 Name 过滤、取第一个同名项目；找不到就 CreatePagesProject 新建同名项目），而 EdgeOne 允许
// 同名项目并存。于是「部署到哪个项目」在 CLI 这一侧是不可控的。
// 这里的策略是：EDGEONE_PROJECT_ID 是权威定位，部署前用 API 按 ID 核对名字、按名字核对唯一性，
// 任何不一致都拒绝部署（一个字节都不传），CLI 的 `-n` 只承担「传递已核对过的名字」。
//
// 区域注意：API 端点由 **token 的签发区域** 决定，不是项目的 Area。
// 腾讯云登录拿到的 token 走 china（ap-guangzhou）；global 账号的 token 走 ap-singapore。
// 项目自己可以是 global 区——两者互不影响（当前画廊项目就是 token=china、Area=global）。

export const EDGEONE_API_REGIONS = {
  china: { baseUrl: 'https://pages-api.cloud.tencent.com/v1', region: 'ap-guangzhou' },
  global: { baseUrl: 'https://pages-api.edgeone.ai/v1', region: 'ap-singapore' },
};

export const DEFAULT_EDGEONE_API_REGION = 'china';

/** EDGEONE_API_REGION → 端点；未知区域返回问题。baseUrl 可覆盖（测试用假服务器）。 */
export function edgeoneApiTarget(region, baseUrl) {
  const key = String(region || DEFAULT_EDGEONE_API_REGION).toLowerCase();
  const target = EDGEONE_API_REGIONS[key];
  if (!target) {
    return { ok: false, problem: `EDGEONE_API_REGION 只能是 ${Object.keys(EDGEONE_API_REGIONS).join(' | ')}，现在是 ${JSON.stringify(region)}` };
  }
  return { ok: true, key, baseUrl: baseUrl || target.baseUrl, region: target.region };
}

async function postPagesApi({ token, target, body, fetchImpl }) {
  const res = await fetchImpl(target.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, Region: target.region }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应：下面按 HTTP 状态报 */
  }
  return { status: res.status, json };
}

/**
 * 调 DescribePagesProjects（只读）。按 ID 或按名字过滤，两者可同时给。
 * @returns {{ ok: true, projects: object[] } | { ok: false, problems: string[] }}
 */
export async function describePagesProjects({ token, region, baseUrl, projectIds, name, fetchImpl = fetch }) {
  const target = edgeoneApiTarget(region, baseUrl);
  if (!target.ok) return { ok: false, problems: [target.problem] };
  if (!token) return { ok: false, problems: ['缺 EDGEONE_API_TOKEN（EdgeOne 的 API Token，不是登录态 token 文件）'] };

  const body = { Action: 'DescribePagesProjects' };
  if (projectIds?.length) body.ProjectIds = projectIds;
  if (name) body.Filters = [{ Name: 'Name', Values: [name] }];

  let res;
  try {
    res = await postPagesApi({ token, target, body, fetchImpl });
  } catch (e) {
    return { ok: false, problems: [`Pages API 请求失败（${target.baseUrl}）：${e.message}`] };
  }
  if (res.status !== 200) {
    return { ok: false, problems: [`Pages API 返回 HTTP ${res.status}（${target.baseUrl}）`] };
  }
  const code = res.json?.Code;
  if (code !== 0) {
    const hint = code === 109 ? '；token 与 EDGEONE_API_REGION 对不上（token 是哪个区域签发的，就要用哪个端点）' : '';
    return { ok: false, problems: [`Pages API 返回 Code=${code}：${res.json?.Message ?? '未知错误'}${hint}`] };
  }
  const response = res.json?.Data?.Response ?? res.json?.Data;
  const projects = Array.isArray(response?.Projects) ? response.Projects : [];
  return { ok: true, projects };
}

/**
 * 部署前校验：ID 必须存在、名字必须与 ID 对应、同名项目必须唯一、项目必须是直传类型。
 * @returns {Promise<string[]>} 问题列表；空数组即通过
 */
export async function verifyEdgeoneProject({ token, region, baseUrl, projectId, projectName, fetchImpl = fetch }) {
  if (!projectId) return ['缺 EDGEONE_PROJECT_ID（EdgeOne 项目 ID，形如 makers-…）'];
  if (!projectName) return ['缺 EDGEONE_PROJECT_NAME（EdgeOne 项目名，只用于 CLI 的 -n）'];

  const byId = await describePagesProjects({ token, region, baseUrl, projectIds: [projectId], fetchImpl });
  if (!byId.ok) return byId.problems;
  const hit = byId.projects.find((p) => p.ProjectId === projectId);
  if (!hit) {
    return [`Pages API 查不到项目 ${projectId}：项目被删了，或 EDGEONE_API_REGION 与 token 的区域对不上`];
  }

  const problems = [];
  if (hit.Name !== projectName) {
    problems.push(`项目 ID ${projectId} 的名字是 ${JSON.stringify(hit.Name)}，与 EDGEONE_PROJECT_NAME=${JSON.stringify(projectName)} 不一致`);
  }
  if (hit.Provider && hit.Provider !== 'Upload') {
    problems.push(`项目 ${projectId} 的 Provider 是 ${hit.Provider}，CLI deploy 只支持直传（Upload）项目`);
  }

  const byName = await describePagesProjects({ token, region, baseUrl, name: projectName, fetchImpl });
  if (!byName.ok) return [...problems, ...byName.problems];
  const sameName = byName.projects.filter((p) => p.Name === projectName);
  if (sameName.length === 0) {
    problems.push(`Pages API 按名字查不到 ${JSON.stringify(projectName)}`);
  } else if (sameName.length > 1) {
    problems.push(
      `存在 ${sameName.length} 个同名项目 ${JSON.stringify(projectName)}（${sameName.map((p) => p.ProjectId).join('、')}）：` +
        'EdgeOne 允许同名，CLI 的 -n 只按名字取第一个，拒绝部署以免发错项目',
    );
  } else if (sameName[0].ProjectId !== projectId) {
    problems.push(
      `名字 ${JSON.stringify(projectName)} 对应的项目 ID 是 ${sameName[0].ProjectId}，与 EDGEONE_PROJECT_ID=${projectId} 不一致`,
    );
  }
  return problems;
}
