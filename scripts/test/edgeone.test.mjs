// EdgeOne 项目定位校验（scripts/lib/edgeone.mjs）的单测。
//
// 为什么值得单测：CLI 的 -n 只按名字取第一个，EdgeOne 又允许多个同名项目；
// 这层校验是「不把站点发到别人项目」的唯一防线，用假 fetch 把各种异常形状钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEdgeoneProject, describePagesProjects, edgeoneApiTarget } from '../lib/edgeone.mjs';

const PROJECT = { ProjectId: 'makers-abc123', Name: 'gallery', Provider: 'Upload', Area: 'global' };

/** 假 fetch：按请求体里有 ProjectIds 还是 Filters 决定返回哪一组项目。 */
function fakeFetch({ byId = [PROJECT], byName = [PROJECT], code = 0, message = 'ok' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const projects = body.ProjectIds ? byId : byName;
    return {
      status: 200,
      json: async () => ({ Code: code, Message: message, Data: { Response: { Projects: projects } } }),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('edgeoneApiTarget：china / global 的端点与 Region；未知值报问题', () => {
  assert.equal(edgeoneApiTarget('china').baseUrl, 'https://pages-api.cloud.tencent.com/v1');
  assert.equal(edgeoneApiTarget('china').region, 'ap-guangzhou');
  assert.equal(edgeoneApiTarget('global').baseUrl, 'https://pages-api.edgeone.ai/v1');
  assert.equal(edgeoneApiTarget('global').region, 'ap-singapore');
  assert.equal(edgeoneApiTarget(undefined).ok, true, '缺省用 china');
  assert.equal(edgeoneApiTarget('mars').ok, false);
  assert.match(edgeoneApiTarget('mars').problem, /EDGEONE_API_REGION 只能是 china \| global/);
});

test('verifyEdgeoneProject：ID 与名字一致、同名唯一、直传类型 → 通过；两次查询都带 Region', async () => {
  const fetchImpl = fakeFetch();
  const problems = await verifyEdgeoneProject({ token: 't', region: 'china', projectId: 'makers-abc123', projectName: 'gallery', fetchImpl });
  assert.deepEqual(problems, []);
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(fetchImpl.calls.map((c) => c.body.Action), ['DescribePagesProjects', 'DescribePagesProjects']);
  assert.deepEqual(fetchImpl.calls.map((c) => c.body.Region), ['ap-guangzhou', 'ap-guangzhou']);
  assert.deepEqual(fetchImpl.calls[0].body.ProjectIds, ['makers-abc123']);
  assert.deepEqual(fetchImpl.calls[1].body.Filters, [{ Name: 'Name', Values: ['gallery'] }]);
});

test('verifyEdgeoneProject：同名项目多个 → 拒绝（CLI 的 -n 只会取第一个）', async () => {
  const fetchImpl = fakeFetch({
    byName: [PROJECT, { ...PROJECT, ProjectId: 'makers-other', Name: 'gallery' }],
  });
  const problems = await verifyEdgeoneProject({ token: 't', region: 'china', projectId: 'makers-abc123', projectName: 'gallery', fetchImpl });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /存在 2 个同名项目 "gallery"（makers-abc123、makers-other）/);
  assert.match(problems[0], /拒绝部署以免发错项目/);
});

test('verifyEdgeoneProject：ID 的名字与 EDGEONE_PROJECT_NAME 不符 / 按 ID 查不到 / Provider 不是 Upload', async () => {
  const rename = fakeFetch({ byId: [{ ...PROJECT, Name: 'other-name' }], byName: [{ ...PROJECT, Name: 'other-name' }] });
  const p1 = await verifyEdgeoneProject({ token: 't', projectId: 'makers-abc123', projectName: 'gallery', fetchImpl: rename });
  assert.match(p1.join('\n'), /项目 ID makers-abc123 的名字是 "other-name"，与 EDGEONE_PROJECT_NAME="gallery" 不一致/);

  const missing = fakeFetch({ byId: [], byName: [] });
  const p2 = await verifyEdgeoneProject({ token: 't', projectId: 'makers-abc123', projectName: 'gallery', fetchImpl: missing });
  assert.match(p2.join('\n'), /Pages API 查不到项目 makers-abc123/);

  const notUpload = fakeFetch({ byId: [{ ...PROJECT, Provider: 'Repo' }], byName: [{ ...PROJECT, Provider: 'Repo' }] });
  const p3 = await verifyEdgeoneProject({ token: 't', projectId: 'makers-abc123', projectName: 'gallery', fetchImpl: notUpload });
  assert.match(p3.join('\n'), /Provider 是 Repo，CLI deploy 只支持直传（Upload）项目/);

  const wrongName = fakeFetch({
    byId: [PROJECT],
    byName: [{ ...PROJECT, ProjectId: 'makers-other' }],
  });
  const p4 = await verifyEdgeoneProject({ token: 't', projectId: 'makers-abc123', projectName: 'gallery', fetchImpl: wrongName });
  assert.match(p4.join('\n'), /名字 "gallery" 对应的项目 ID 是 makers-other/);
});

test('verifyEdgeoneProject：缺 ID / 缺名字 / 缺 token 直接点名', async () => {
  assert.deepEqual(await verifyEdgeoneProject({ token: 't', projectId: '', projectName: 'g' }), [
    '缺 EDGEONE_PROJECT_ID（EdgeOne 项目 ID，形如 makers-…）',
  ]);
  assert.deepEqual(await verifyEdgeoneProject({ token: 't', projectId: 'makers-x', projectName: '' }), [
    '缺 EDGEONE_PROJECT_NAME（EdgeOne 项目名，只用于 CLI 的 -n）',
  ]);
  const p = await verifyEdgeoneProject({ token: '', projectId: 'makers-x', projectName: 'g' });
  assert.match(p.join('\n'), /缺 EDGEONE_API_TOKEN/);
});

test('describePagesProjects：Code 109 提示 token 区域对不上；HTTP 非 200 与区域非法都报问题', async () => {
  const regionMismatch = fakeFetch({ code: 109, message: 'The Token usage region is incorrect.' });
  const r1 = await describePagesProjects({ token: 't', region: 'global', projectIds: ['makers-x'], fetchImpl: regionMismatch });
  assert.equal(r1.ok, false);
  assert.match(r1.problems[0], /Code=109/);
  assert.match(r1.problems[0], /token 与 EDGEONE_API_REGION 对不上/);

  const http500 = async () => ({ status: 500, json: async () => ({}) });
  const r2 = await describePagesProjects({ token: 't', region: 'china', projectIds: ['makers-x'], fetchImpl: http500 });
  assert.equal(r2.ok, false);
  assert.match(r2.problems[0], /HTTP 500/);

  const r3 = await describePagesProjects({ token: 't', region: 'mars', projectIds: ['makers-x'], fetchImpl: fakeFetch() });
  assert.equal(r3.ok, false);
  assert.match(r3.problems[0], /EDGEONE_API_REGION/);
});
