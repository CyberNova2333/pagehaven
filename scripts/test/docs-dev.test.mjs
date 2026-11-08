import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startDocsDev } from '../docs-dev.mjs';

const DOCS = fileURLToPath(new URL('../../docs-site/', import.meta.url));
const docsRequire = createRequire(join(DOCS, 'package.json'));

async function listen(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

const closePort = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('文档开发：引用正文与直接页面的连续编辑重建索引，删除标题不留旧结果', { timeout: 90_000 }, async (t) => {
  let MiniSearch;
  try {
    MiniSearch = docsRequire('minisearch');
    docsRequire.resolve('vitepress/package.json');
  } catch {
    assert.fail('文档依赖未安装，请先运行 pnpm --dir docs-site install --frozen-lockfile');
  }
  const temp = await mkdtemp(join(tmpdir(), 'pagehaven-docs-dev-test-'));
  const root = join(temp, 'docs-site');
  const guide = join(temp, 'repo-docs');
  const dependencies = join(root, 'node_modules');
  let linked = false, dev;
  t.after(async () => {
    await dev?.close();
    // 先拆除指向真实依赖的链接，只递归删除测试自己创建的临时目录。
    if (linked) await unlink(dependencies);
    await rm(temp, { recursive: true, force: true });
  });
  await mkdir(join(root, '.vitepress'), { recursive: true });
  await mkdir(guide);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await symlink(join(DOCS, 'node_modules'), dependencies, process.platform === 'win32' ? 'junction' : 'dir');
  linked = true;
  await copyFile(join(DOCS, '.vitepress/guide-search-refresh.mjs'), join(root, '.vitepress/guide-search-refresh.mjs'));
  await writeFile(join(root, '.vitepress/config.mjs'), `import { guideSearchRefresh } from './guide-search-refresh.mjs';
export default {
  cleanUrls: true,
  themeConfig: { search: { provider: 'local' } },
  vite: { plugins: [guideSearchRefresh()] },
};\n`);
  await writeFile(join(root, 'index.md'), '# Development fixture\n\nSearch refresh regression.\n');
  await writeFile(join(root, 'included.md'), '<!--@include: ../repo-docs/content.md-->\n');
  const included = join(guide, 'content.md');
  const direct = join(root, 'direct.md');
  await writeFile(included, '# Included guide\n\n## includebefore\n\nInitial included content.\n');
  await writeFile(direct, '# Direct guide\n\n## directbefore\n\nInitial direct content.\n');
  const reservation = await listen();
  const port = reservation.address().port;
  await closePort(reservation);
  const base = `http://127.0.0.1:${port}`;
  dev = startDocsDev(root, ['--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
  let exited;
  void dev.closed.then((code) => { exited = code; });

  // 读取实际开发服务器提供的模块，而不是自行重新生成一个测试索引。
  // 不请求 included.md 正文，确保外部 include 不依赖浏览器先访问其所属页。
  async function readSearch() {
    const response = await fetch(`${base}/@localSearchIndex`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
    const indexMap = await response.text();
    const indexPath = indexMap.match(/import\(["']([^"']*localSearchIndexroot[^"']*)["']\)/)?.[1];
    assert.ok(indexPath, `缺少默认语言索引：${indexMap.slice(0, 200)}`);
    const indexResponse = await fetch(new URL(indexPath, base), { signal: AbortSignal.timeout(2_000) });
    assert.equal(indexResponse.status, 200);
    const module = await indexResponse.text();
    const encoded = module.match(/export default\s+("(?:\\.|[^"\\])*")/)?.[1];
    assert.ok(encoded, `搜索模块没有序列化索引：${module.slice(0, 200)}`);
    return MiniSearch.loadJSON(JSON.parse(encoded), { fields: ['title', 'titles', 'text'], storeFields: ['title', 'titles'] });
  }
  async function expectSearch(present, absent = []) {
    const deadline = Date.now() + 20_000;
    let last;
    while (Date.now() < deadline) {
      assert.equal(exited, undefined, `开发服务提前退出：${exited}`);
      try {
        const search = await readSearch();
        for (const [term, id] of present) {
          assert.ok(search.search(term).some((hit) => hit.id === id), `${term} 应指向 ${id}`);
        }
        for (const term of absent) assert.equal(search.search(term).length, 0, `${term} 的旧章节必须删除`);
        return;
      } catch (error) {
        last = error;
      }
      await delay(100);
    }
    throw last;
  }

  await expectSearch([['includebefore', '/included#includebefore'], ['directbefore', '/direct#directbefore']]);
  await writeFile(included, '# Included guide\n\n## includeafter\n\nUpdated included content.\n');
  await expectSearch([['includeafter', '/included#includeafter']], ['includebefore']);
  await writeFile(direct, '# Direct guide\n\n## directafter\n\nUpdated direct content.\n');
  await expectSearch([['directafter', '/direct#directafter']], ['directbefore']);

  // 两次保存落在同一去抖窗口内，最终索引必须反映最后一次磁盘内容。
  await writeFile(included, '# Included guide\n\n## intermediateterm\n\nIntermediate content.\n');
  await writeFile(included, '# Included guide\n\n## finalterm\n\nFinal content.\n');
  await expectSearch([['finalterm', '/included#finalterm']], ['intermediateterm', 'includeafter']);
  await writeFile(direct, '# Direct guide\n\nAll former sections removed.\n');
  await expectSearch([['finalterm', '/included#finalterm']], ['directafter']);

  assert.equal(await dev.close(), 0);
  const released = await listen(port);
  await closePort(released);
});
