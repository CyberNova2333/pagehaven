// 维护者临时配置工具；只改唯一 YAML，不参与正式站点的请求处理。
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { parseDocument } from 'yaml';
import { SiteConfigSchema } from '@gallery/platform';
import { readInitConfig, writeInitConfig } from './init-site.mjs';
import { ROOT, SITE_DIR } from './paths.mjs';

const BODY_LIMIT = 16 * 1024;
const FIELDS = {
  title: ['site', 'title'], logo: ['site', 'logo'], tagline: ['site', 'tagline'],
  theme: ['appearance', 'theme'], accent: ['appearance', 'accent'], font: ['appearance', 'font'],
  showSearch: ['appearance', 'show_search'], showLibrary: ['appearance', 'show_library'],
  textLayer: ['features', 'text_layer'], enhancedReader: ['features', 'comimi_reader'],
};
const BOOLEANS = new Set(['showSearch', 'showLibrary', 'textLayer', 'enhancedReader']);
const STATIC_FILES = new Map([
  ['/', [join(ROOT, 'scripts', 'customize', 'index.html'), 'text/html; charset=utf-8']],
  ['/customize.js', [join(ROOT, 'scripts', 'customize', 'customize.js'), 'text/javascript; charset=utf-8']],
  ['/customize.css', [join(ROOT, 'scripts', 'customize', 'customize.css'), 'text/css; charset=utf-8']],
  ['/site-appearance.js', [join(SITE_DIR, 'src', 'lib', 'site-appearance.js'), 'text/javascript; charset=utf-8']],
  ['/favicon.svg', [join(SITE_DIR, 'public', 'favicon.svg'), 'image/svg+xml']],
]);
const ownObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const revisionOf = (text) => createHash('sha256').update(text).digest('hex');
const at = (object, path) => path.reduce((value, key) => value[key], object);

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function configResult(text, config) {
  return { settings: Object.fromEntries(Object.entries(FIELDS).map(([name, path]) => [name, at(config, path)])), revision: revisionOf(text) };
}

export function readCustomSettings(text) {
  return configResult(text, readInitConfig(text));
}

/** 仅修改已登记字段；类型与取值仍由唯一配置 schema 决定。 */
export function planCustomization(text, settings) {
  if (!ownObject(settings) || Object.keys(settings).length !== Object.keys(FIELDS).length ||
      Object.keys(settings).some((name) => !Object.hasOwn(FIELDS, name)) ||
      Object.keys(FIELDS).some((name) => !Object.hasOwn(settings, name))) {
    throw new Error('请提交完整的站点自定义设置，不能包含未支持的字段');
  }
  for (const [name, value] of Object.entries(settings)) {
    if (typeof value !== (BOOLEANS.has(name) ? 'boolean' : 'string')) throw new Error(`${name}: 设置类型不正确`);
  }
  const before = readInitConfig(text);
  const expected = structuredClone(before);
  for (const [name, path] of Object.entries(FIELDS)) at(expected, path.slice(0, -1))[path.at(-1)] = settings[name];
  const checked = SiteConfigSchema.safeParse(expected);
  if (!checked.success) {
    throw new Error(checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
  }
  const config = checked.data;
  const doc = parseDocument(text, { merge: true, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length) throw new Error('无法安全编辑此 YAML，请先修正语法或自定义标签');
  const changes = [];
  for (const path of Object.values(FIELDS)) {
    const oldValue = at(before, path);
    const newValue = at(config, path);
    if (isDeepStrictEqual(oldValue, newValue)) continue;
    changes.push({ path: path.join('.'), before: oldValue, after: newValue });
    try { doc.setIn(path, newValue); } catch {
      throw new Error(`无法安全修改 ${path.join('.')}，请先展开该处 YAML 别名`);
    }
  }
  let next = changes.length ? doc.toString({ lineWidth: 0 }) : text;
  if (changes.length && text.includes('\r\n')) next = next.replace(/\n/g, '\r\n');
  if (changes.length && text.startsWith('\uFEFF') && !next.startsWith('\uFEFF')) next = '\uFEFF' + next;
  if (!isDeepStrictEqual(readInitConfig(next), config)) throw new Error('YAML 别名会影响未选择字段，请先展开相关节点');
  return { text: next, config, changes };
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function authorized(request, token) {
  const actual = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sameOrigin(request) {
  if (request.headers.origin === undefined) return true;
  try {
    const origin = new URL(request.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.origin === request.headers.origin && origin.host === request.headers.host;
  } catch { return false; }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT) { failed = true; reject(new RequestError(413, '设置内容超过 16 KiB 限制')); return; }
      chunks.push(chunk);
    });
    request.on('error', () => { failed = true; reject(new RequestError(400, '无法读取设置内容')); });
    request.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new RequestError(400, '设置内容不是有效 JSON')); }
    });
  });
}

/** 监听地址由调用方决定；浏览器不能指定文件路径或调用任意命令。 */
export function createCustomizer({ configFile, backupDir, token }) {
  if (!configFile || !backupDir || typeof token !== 'string' || !token) throw new Error('自定义工具缺少配置路径、备份目录或会话凭证');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const path = new URL(request.url, 'http://customize.invalid').pathname;
      if (path !== '/api/settings') {
        const resource = STATIC_FILES.get(path);
        if (!resource) throw new RequestError(404, '页面不存在');
        if (request.method !== 'GET') throw new RequestError(405, '请求方式不支持');
        const contents = await readFile(resource[0]);
        response.writeHead(200, { 'Content-Type': resource[1] });
        response.end(contents);
        return;
      }
      if (!authorized(request, token)) throw new RequestError(401, '请使用启动时提供的完整链接打开配置工具');
      if (request.method === 'GET') {
        json(response, 200, readCustomSettings(await readFile(configFile, 'utf8')));
        return;
      }
      if (request.method !== 'POST') throw new RequestError(405, '请求方式不支持');
      if (!sameOrigin(request)) throw new RequestError(403, '只接受配置页面自身发起的保存请求');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new RequestError(415, '保存请求必须使用 JSON');
      const body = await readBody(request);
      if (!ownObject(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'settings') ||
          !Object.hasOwn(body, 'revision') || typeof body.revision !== 'string' || !/^[0-9a-f]{64}$/.test(body.revision)) {
        throw new RequestError(400, '保存请求需要设置内容与有效的配置版本');
      }
      const original = await readFile(configFile, 'utf8');
      if (revisionOf(original) !== body.revision) throw new RequestError(409, '配置已被其他页面修改，请重新载入后再保存');
      let plan;
      try { plan = planCustomization(original, body.settings); } catch (error) { throw new RequestError(400, error.message); }
      let result;
      try { result = await writeInitConfig(configFile, original, plan.text, { backupDir }); } catch (error) {
        if (error.code === 'EEXIST' || error.cause?.code === 'EEXIST' || /配置在预览后已被修改/.test(error.message)) throw new RequestError(409, '配置正在修改，请重新载入后再保存');
        throw error;
      }
      json(response, 200, { ...configResult(plan.text, plan.config), changed: result.changed, changes: plan.changes });
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : '配置操作失败，请检查配置文件与写入权限' });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

export function parseCustomizeArgs(args) {
  const { values } = parseArgs({ args, options: {
    host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '4318' },
    config: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  }, strict: true, allowPositionals: false });
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(values.host)) throw new Error('--host 只支持 127.0.0.1、localhost 或 0.0.0.0');
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) throw new Error('--port 必须是 1–65535 之间的整数');
  if (values.config !== undefined && !values.config.trim()) throw new Error('--config 路径不能为空');
  return { ...values, port: Number(values.port) };
}
