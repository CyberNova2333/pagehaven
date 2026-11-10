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

test('文档开发：真实配置下双语索引随编辑更新，浏览器缓存不复用旧结果', { timeout: 120_000 }, async (t) => {
  let MiniSearch;
  try {
    // MiniSearch 是 VitePress 的依赖；pnpm 不保证把它提升到 docs-site 根目录。
    MiniSearch = createRequire(docsRequire.resolve('vitepress/package.json'))('minisearch');
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
  await mkdir(join(root, 'en'));
  await mkdir(guide);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await symlink(join(DOCS, 'node_modules'), dependencies, process.platform === 'win32' ? 'junction' : 'dir');
  linked = true;
  await copyFile(join(DOCS, '.vitepress/guide-search-refresh.mjs'), join(root, '.vitepress/guide-search-refresh.mjs'));
  // 必须使用项目实际配置，避免测试私自接线、真实站点却没启用刷新插件。
  await copyFile(join(DOCS, '.vitepress/config.mts'), join(root, '.vitepress/config.mts'));
  await writeFile(join(root, 'index.md'), '# Development fixture\n\nSearch refresh regression.\n');
  await writeFile(join(root, 'included.md'), '<!--@include: ../repo-docs/content.md-->\n');
  const included = join(guide, 'content.md');
  const direct = join(root, 'direct.md');
  const english = join(root, 'en/index.md');
  await writeFile(included, '# Included guide\n\n## includebefore\n\nInitial included content.\n');
  await writeFile(direct, '# Direct guide\n\n## directbefore\n\nInitial direct content.\n');
  await writeFile(english, '# English guide\n\n## englishbefore\n\nInitial English content.\n');
  const reservation = await listen();
  const port = reservation.address().port;
  await closePort(reservation);
  const base = `http://127.0.0.1:${port}`;
  dev = startDocsDev(root, ['--', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
  let exited;
  void dev.closed.then((code) => { exited = code; });

  // 读取实际开发服务器提供的模块，而不是自行重新生成一个测试索引。
  // 不请求 included.md 正文，确保外部 include 不依赖浏览器先访问其所属页。
  // 模拟浏览器对 immutable 响应的复用。普通 Node fetch 不保留 HTTP 缓存，
  // 只检查服务端 JSON 会漏掉进程重启后 v=1 再次指向旧缓存的问题。
  const immutableCache = new Map();
  async function readSearch() {
    const response = await fetch(`${base}/@localSearchIndex`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
    const indexMap = await response.text();
    const indexes = {};
    for (const locale of ['root', 'en']) {
      const indexPath = indexMap.match(new RegExp(`import\\(["']([^"']*localSearchIndex${locale}[^"']*)["']\\)`))?.[1];
      assert.ok(indexPath, `缺少 ${locale} 语言索引：${indexMap.slice(0, 200)}`);
      let module = immutableCache.get(indexPath);
      if (!module) {
        const indexResponse = await fetch(new URL(indexPath, base), { signal: AbortSignal.timeout(2_000) });
        assert.equal(indexResponse.status, 200);
        module = await indexResponse.text();
        if (/\bimmutable\b/.test(indexResponse.headers.get('cache-control') ?? '')) immutableCache.set(indexPath, module);
      }
      const encoded = module.match(/export default\s+("(?:\\.|[^"\\])*")/)?.[1];
      assert.ok(encoded, `搜索模块没有序列化索引：${module.slice(0, 200)}`);
      indexes[locale] = {
        path: indexPath,
        search: MiniSearch.loadJSON(JSON.parse(encoded), { fields: ['title', 'titles', 'text'], storeFields: ['title', 'titles'] }),
      };
    }
    return indexes;
  }
  async function expectSearch(present, absent = [], previous) {
    const deadline = Date.now() + 20_000;
    let last;
    while (Date.now() < deadline) {
      assert.equal(exited, undefined, `开发服务提前退出：${exited}`);
      try {
        const indexes = await readSearch();
        for (const [locale, term, id] of present) {
          assert.ok(indexes[locale].search.search(term).some((hit) => hit.id === id), `${locale} 的 ${term} 应指向 ${id}`);
          const other = locale === 'root' ? 'en' : 'root';
          assert.equal(indexes[other].search.search(term).length, 0, `${term} 不应进入另一语言的索引`);
        }
        for (const term of absent) {
          for (const locale of ['root', 'en']) assert.equal(indexes[locale].search.search(term).length, 0, `${term} 的旧章节必须删除`);
        }
        if (previous) {
          for (const locale of ['root', 'en']) assert.notEqual(indexes[locale].path, previous[locale].path, `${locale} 的索引 URL 必须区分开发服务的不同启动`);
        }
        return indexes;
      } catch (error) {
        last = error;
      }
      await delay(100);
    }
    throw last;
  }

  let indexes = await expectSearch([
    ['root', 'includebefore', '/included#includebefore'],
    ['root', 'directbefore', '/direct#directbefore'],
    ['en', 'englishbefore', '/en/#englishbefore'],
  ]);
  await writeFile(included, '# Included guide\n\n## includeafter\n\nUpdated included content.\n');
  indexes = await expectSearch([['root', 'includeafter', '/included#includeafter'], ['en', 'englishbefore', '/en/#englishbefore']], ['includebefore'], indexes);
  await writeFile(direct, '# Direct guide\n\n## directafter\n\nUpdated direct content.\n');
  indexes = await expectSearch([['root', 'directafter', '/direct#directafter']], ['directbefore'], indexes);
  await writeFile(english, '# English guide\n\n## englishafter\n\nUpdated English content.\n');
  indexes = await expectSearch([['en', 'englishafter', '/en/#englishafter'], ['root', 'directafter', '/direct#directafter']], ['englishbefore'], indexes);

  // 两次保存落在同一去抖窗口内，最终索引必须反映最后一次磁盘内容。
  await writeFile(included, '# Included guide\n\n## intermediateterm\n\nIntermediate content.\n');
  await writeFile(included, '# Included guide\n\n## finalterm\n\nFinal content.\n');
  indexes = await expectSearch([['root', 'finalterm', '/included#finalterm']], ['intermediateterm', 'includeafter'], indexes);
  await writeFile(direct, '# Direct guide\n\nAll former sections removed.\n');
  indexes = await expectSearch([['root', 'finalterm', '/included#finalterm']], ['directafter'], indexes);

  const added = join(root, 'en/added.md');
  await writeFile(added, '# Added guide\n\n## addedterm\n\nNew English page.\n');
  indexes = await expectSearch([['en', 'addedterm', '/en/added#addedterm']], [], indexes);
  await unlink(added);
  await expectSearch([['en', 'englishafter', '/en/#englishafter']], ['addedterm'], indexes);

  assert.equal(await dev.close(), 0);
  const released = await listen(port);
  await closePort(released);
});
