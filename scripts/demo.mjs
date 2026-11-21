// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, sep } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadSiteConfig } from './lib/config.mjs';
import { ROOT } from './lib/paths.mjs';
import { R2_ENV_KEYS } from './lib/r2.mjs';

const run = promisify(execFile);
const sample = join(ROOT, 'scripts', 'demo');
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.sqlite': 'application/vnd.sqlite3',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
};

// Only expose known reader files and the exact objects referenced by this build.
async function filesForDemo(dist, out) {
  const files = new Map();
  for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const url = file.slice(dist.length).split(sep).join('/');
    files.set(url, file);
    if (url.endsWith('/index.html')) files.set(url.slice(0, -'index.html'.length), file);
  }
  const { imageKeys, db } = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  for (const key of imageKeys) {
    const hash = /-([a-f0-9]{12})\.webp$/.exec(key)[1];
    const file = join(sample, 'art', hash + '.webp');
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    if (!digest.startsWith(hash)) throw new Error('样张与图片摘要不符：' + key);
    files.set('/' + key, file);
  }
  for (const key of [db.key, db.chunks]) files.set('/' + key, join(out, 'db', basename(key)));
  return files;
}

export async function startDemo({ host = '127.0.0.1', port = 4321 } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'pagehaven-demo-'));
  const dist = join(work, 'dist');
  const out = join(work, 'out');
  const env = { ...process.env, BUILD_WORK_DIR: work, DATA_DIR: join(sample, 'data'), DIST_DIR: dist,
    OUT_DIR: out, CONFIG_FILE: join(work, 'demo.yaml'), DEPLOY_ENV: 'preview', RELEASE_VERSION: 'local-demo' };
  for (const name of R2_ENV_KEYS) delete env[name];
  try {
    const config = await loadSiteConfig();
    config.site.logo = '/favicon.svg';
    Object.assign(config.features, { text_layer: true, range_search: false, platform_config: false });
    Object.assign(config.appearance, { show_search: true, show_library: true });
    await writeFile(env.CONFIG_FILE, JSON.stringify(config));
    for (const step of ['config', 'manifest', 'db', 'site', 'index', 'sitemap']) {
      const args = [join(ROOT, 'scripts', 'build-' + step + '.mjs')];
      if (step === 'site') args.push('--same-origin-assets');
      await run(process.execPath, args, { cwd: ROOT, env });
    }
    const files = await filesForDemo(dist, out);
    const server = createServer(async (req, res) => {
      const file = files.get(req.url.split('?')[0]);
      if (!file || !['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(file ? 405 : 404).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
    return { port: server.address().port, close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(work, { recursive: true, force: true });
    } };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '4321' } } });
  console.log('正在构建《潮汐手记》与本地台词库……');
  const demo = await startDemo({ host: values.host, port: Number(values.port) });
  console.log('样本站已就绪，打开端口 ' + demo.port + ' 或 http://localhost:' + demo.port + '/ ，在搜索页试试「灯塔」。');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => demo.close());
}
