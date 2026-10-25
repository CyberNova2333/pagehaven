// 推 gh-pages 只证明产物已接收；生产启用前还要核对该提交的 Pages 构建已完成。
const API_ROOT = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 只读查询当前仓库的 Pages 配置与最新构建，不创建构建、不读取其他仓库。
 * GitHub 分支发布的 latest build 返回 commit/status；旧提交即使 built 也不能算本次成功。
 * fetch/clock/sleep 注入只用于离线测试，生产请求始终走官方 API。
 */
export async function waitForGithubPagesBuild({
  repo, token, commit,
  fetchImpl = fetch,
  timeoutMs = 12 * 60_000,
  intervalMs = 10_000,
  requestTimeoutMs = 15_000,
  now = () => performance.now(),
  sleepImpl = sleep,
  onProgress = () => {},
}) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error('GitHub Pages 仓库必须是 owner/repo');
  }
  if (!token || typeof token !== 'string') throw new Error('缺少 GitHub Pages 查询凭据');
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('必须提供本次 gh-pages 提交的完整 SHA');
  for (const value of [timeoutMs, intervalMs, requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Pages 等待时间必须为正整数毫秒');
  }
  const deadline = now() + timeoutMs;
  const endpoint = `${API_ROOT}/repos/${repo.split('/').map(encodeURIComponent).join('/')}/pages`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': API_VERSION,
    'user-agent': 'gallery-release',
    'cache-control': 'no-cache',
  };
  let checkedSource = false;
  let lastProgress = '';
  const progress = (message) => {
    if (message !== lastProgress) onProgress(message);
    lastProgress = message;
  };

  const request = async (url, allowMissing) => {
    let response;
    try {
      response = await fetchImpl(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, Math.ceil(deadline - now())))),
      });
    } catch {
      return { wait: 'Pages 状态查询暂时不可用，等待重试' };
    }
    if (!response.ok) await response.body?.cancel().catch(() => {});
    if (response.status === 404 && allowMissing) return { wait: '等待本次 Pages 构建出现' };
    if (response.status === 429 || response.status >= 500 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
      return { wait: `Pages 状态查询暂时返回 HTTP ${response.status}，等待重试` };
    }
    if (!response.ok) {
      throw new Error(`Pages 状态查询失败：HTTP ${response.status}；请核对仓库发布源和 Pages 读取权限`);
    }
    try {
      return { data: await response.json() };
    } catch {
      return { wait: 'Pages 状态响应不完整，等待重试' };
    }
  };

  while (now() < deadline) {
    if (!checkedSource) {
      const site = await request(endpoint, false);
      if (site.data) {
        if (site.data.build_type === 'workflow' || site.data.source?.branch !== 'gh-pages' || site.data.source?.path !== '/') {
          throw new Error('GitHub Pages 发布源必须是 gh-pages 分支根目录，不能使用其他分支或自定义工作流');
        }
        checkedSource = true;
      } else progress(site.wait);
    }
    if (checkedSource && now() < deadline) {
      const response = await request(`${endpoint}/builds/latest`, true);
      const build = response.data;
      if (build) {
        if (typeof build.commit !== 'string' || build.commit.toLowerCase() !== commit.toLowerCase()) {
          progress('Pages 当前构建仍属于其他提交，等待本次提交');
        } else if (build.status === 'errored' || build.error?.message) {
          // 不原样打印远端 error.message：可能含路径、站点标识或其他运行时信息。
          throw new Error('本次提交的 GitHub Pages 构建失败，生产版本不能启用');
        } else if (build.status === 'built') {
          progress('本次提交的 GitHub Pages 构建已完成');
          return { commit: build.commit, status: build.status };
        } else {
          progress('本次 Pages 构建正在排队或执行');
        }
      } else progress(response.wait);
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleepImpl(Math.min(intervalMs, remaining));
  }
  throw new Error('等待本次 GitHub Pages 发布超时，生产指针未启用；请检查该提交的 Pages 构建');
}
