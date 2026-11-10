import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import yaml from 'js-yaml';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const importers = ['.', 'packages/core', 'packages/platform', 'packages/search', 'packages/site'];
const manifests = new Map(await Promise.all(importers.map(async (path) => [
  path, JSON.parse(await read(`${path}/package.json`)),
])));

function businessLock(source) {
  // pnpm 12 的同一个锁文件还包含包管理器自身的 YAML 文档，不能只读取第一段。
  const candidates = yaml.loadAll(source).filter((doc) => doc?.importers && Object.values(doc.importers)
    .some((importer) => importer.dependencies || importer.devDependencies));
  assert.equal(candidates.length, 1, '必须存在唯一的业务依赖锁文档，不能只锁住包管理器');
  return candidates[0];
}

const lock = businessLock(await read('pnpm-lock.yaml'));

test('工作区：实际登记四个业务包，文档项目保持独立安装边界', async () => {
  const workspace = yaml.load(await read('pnpm-workspace.yaml'));
  assert.ok(workspace.packages?.includes('packages/*'), 'package.json 的 workspaces 不能替代 pnpm 工作区登记');
  assert.deepEqual(Object.keys(lock.importers).sort(), [...importers].sort(), '业务锁必须包含根项目和四个业务包，不能依赖旧 node_modules 链接');
  const docsWorkspace = yaml.load(await read('docs-site/pnpm-workspace.yaml'));
  assert.ok(docsWorkspace && typeof docsWorkspace === 'object', '文档项目必须保留自己的工作区边界');
  const docsLock = businessLock(await read('docs-site/pnpm-lock.yaml'));
  assert.deepEqual(Object.keys(docsLock.importers), ['.'], '文档锁不能混入业务工作区');
  assert.ok(docsLock.importers['.'].devDependencies?.vitepress, '文档依赖由独立锁文件提供');
});

test('工作区：构建脚本与包间导入必须显式声明，并锁到本地 workspace 包', () => {
  const edges = [
    ['.', 'devDependencies', '@gallery/core', 'packages/core'],
    ['.', 'devDependencies', '@gallery/platform', 'packages/platform'],
    ['packages/platform', 'dependencies', '@gallery/core', 'packages/core'],
    ['packages/search', 'dependencies', '@gallery/core', 'packages/core'],
    ['packages/site', 'dependencies', '@gallery/core', 'packages/core'],
    ['packages/site', 'dependencies', '@gallery/search', 'packages/search'],
  ];
  for (const [owner, section, dependency, target] of edges) {
    const description = `${owner} → ${dependency}`;
    assert.equal(manifests.get(owner)[section]?.[dependency], 'workspace:*', `${description} 必须显式声明，不能从注册表找同名包`);
    const linked = lock.importers[owner]?.[section]?.[dependency];
    assert.equal(linked?.specifier, 'workspace:*', `${description} 的锁必须与声明一致`);
    assert.ok(linked.version.startsWith('link:'), `${description} 必须是本地链接，不能是远端版本`);
    assert.equal(posix.normalize(posix.join(owner, linked.version.slice('link:'.length))), target, `${description} 链接必须指向正确工作区`);
    assert.equal(manifests.get(target).name, dependency);
  }
});
