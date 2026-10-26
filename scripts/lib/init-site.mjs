// 初始化只编辑既有配置；平台 schema、发布目标和生成器继续各自负责原来的职责。
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isSeq, parseDocument } from 'yaml';
import { parseSiteConfig } from '@gallery/platform';
import { RELEASE_TARGETS, releasePlan } from './release.mjs';

export const SETUP_TARGETS = ['none', ...RELEASE_TARGETS];
const FIELDS = {
  title: ['site', 'title'], domain: ['site', 'domain'], 'site-lang': ['site', 'lang'],
  'image-host': ['images', 'hosts'], project: ['deploy', 'cloudflare', 'project'],
  'text-layer': ['features', 'text_layer'], 'enhanced-reader': ['features', 'comimi_reader'],
  'platform-config': ['features', 'platform_config'],
};
const BOOLEAN_FIELDS = new Set(['text-layer', 'enhanced-reader', 'platform-config']);
export const say = (locale, zh, en) => locale === 'en' ? en : zh;

export function parseInitArgs(args) {
  const options = Object.fromEntries(Object.keys(FIELDS).map((name) => [name, { type: 'string', ...(name === 'image-host' ? { multiple: true } : {}) }]));
  const { values } = parseArgs({ args, options: {
    ...options, config: { type: 'string' }, target: { type: 'string' },
    'ui-lang': { type: 'string', default: 'zh' }, help: { type: 'boolean', short: 'h' },
    write: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  const locale = values['ui-lang'];
  if (!['zh', 'en'].includes(locale)) throw new Error('--ui-lang: zh | en');
  if (values.write && values['dry-run']) throw new Error(say(locale, '--write 与 --dry-run 不能同时使用', '--write and --dry-run cannot be combined'));
  if (values.config !== undefined && !values.config.trim()) throw new Error('--config: ' + say(locale, '路径不能为空', 'path must not be empty'));
  const target = values.target ?? 'none';
  if (!SETUP_TARGETS.includes(target)) throw new Error(`--target: ${SETUP_TARGETS.join(' | ')}`);
  const edits = Object.fromEntries(Object.keys(FIELDS).filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
  const interactive = !Object.keys(edits).length && values.target === undefined && !values.write && !values['dry-run'];
  return { locale, target, edits, config: values.config, help: values.help, write: values.write, interactive };
}

function checkedConfig(text, locale) {
  try { return parseSiteConfig(text); } catch (error) {
    // YAML 语法错误可能附带整行输入；只显示位置，不把文件中的意外凭据回显到日志。
    if (error.name === 'YAMLException') {
      const line = (error.mark?.line ?? 0) + 1;
      throw new Error(say(locale, `YAML 语法错误，第 ${line} 行`, `Invalid YAML at line ${line}`), { cause: error });
    }
    throw new Error(say(locale, '配置校验失败：\n', 'Configuration validation failed (schema details):\n') + error.message, { cause: error });
  }
}

export function readInitConfig(text, locale = 'zh') {
  return checkedConfig(text, locale);
}

/** 保留未选字段与注释；若别名编辑产生连带变化，拒绝写入而不是改动其他设置。 */
export function planInit(text, edits, { locale = 'zh', target = 'none' } = {}) {
  if (!SETUP_TARGETS.includes(target)) throw new Error(`--target: ${SETUP_TARGETS.join(' | ')}`);
  const before = checkedConfig(text, locale);
  const expected = structuredClone(before);
  const doc = parseDocument(text, { merge: true, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length) throw new Error(say(locale, '初始化无法安全编辑此 YAML，请先修正语法或自定义标签', 'Setup cannot safely edit this YAML; fix its syntax or custom tags first'));
  const changes = [];
  for (const [name, input] of Object.entries(edits)) {
    const path = FIELDS[name];
    if (!path) throw new Error(`Unknown setup option: ${name}`);
    let value;
    if (BOOLEAN_FIELDS.has(name)) {
      if (!['true', 'false'].includes(input)) throw new Error(`--${name}: true | false`);
      value = input === 'true';
    } else if (name === 'image-host') {
      if (!Array.isArray(input)) throw new Error('--image-host: ' + say(locale, '请逐个指定域名', 'specify each hostname separately'));
      value = input.map((host) => host.trim().toLowerCase());
      if (new Set(value).size !== value.length) throw new Error(say(locale, '图片域名不能重复', 'Image hostnames must be unique'));
    } else {
      value = input.trim();
      if (!value || [...value].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) throw new Error(`--${name}: ` + say(locale, '不能为空或包含控制字符', 'must not be empty or contain control characters'));
      if (name === 'domain') value = value.toLowerCase();
    }
    let parent = expected;
    for (const key of path.slice(0, -1)) parent = parent[key];
    const key = path.at(-1);
    if (isDeepStrictEqual(parent[key], value)) continue;
    changes.push({ path: path.join('.'), before: parent[key], after: value });
    parent[key] = value;
    try {
      const node = doc.getIn(path, true);
      if (Array.isArray(value) && isSeq(node)) {
        value.forEach((host, i) => node.set(i, host));
        node.items.splice(value.length);
      } else doc.setIn(path, value);
    } catch {
      throw new Error(say(locale, `无法安全修改 ${path.join('.')}，请先展开该处 YAML 别名`, `Cannot safely edit ${path.join('.')}; expand its YAML alias first`));
    }
  }
  let nextText = changes.length ? doc.toString({ lineWidth: 0 }) : text;
  if (changes.length && text.includes('\r\n')) nextText = nextText.replace(/\n/g, '\r\n');
  if (changes.length && text.startsWith('\uFEFF') && !nextText.startsWith('\uFEFF')) nextText = '\uFEFF' + nextText;
  const config = checkedConfig(nextText, locale);
  if (!isDeepStrictEqual(config, expected)) throw new Error(say(locale, 'YAML 别名或类型转换会影响未选择字段，请先手动展开相关节点', 'YAML aliases or type conversion would change unselected fields; expand the affected nodes first'));
  let productionDomainsReady = true;
  try {
    // 三个平台使用相同的生产域名守卫；未选目标时也给出预览域名提示。
    releasePlan({ target: target === 'none' ? RELEASE_TARGETS[0] : target, domain: config.site.domain, imageHosts: config.images.hosts });
  } catch { productionDomainsReady = false; }
  return { text: nextText, config, changes, target, productionDomainsReady };
}

/** 同目录 rename 保证单文件替换；独占锁防止两个初始化进程互相覆盖。 */
export async function writeInitConfig(file, original, next, { backupDir, locale = 'zh' }) {
  if (next === original) return { changed: false };
  const lockPath = `${file}.init.lock`;
  const tempPath = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let lock;
  try { lock = await open(lockPath, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(say(locale, '配置已有初始化锁；确认其他初始化进程已结束后再处理锁文件', 'A setup lock already exists; check for another running setup before removing the lock file'), { cause: error });
    throw error;
  }
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(say(locale, '初始化只修改普通配置文件，不替换符号链接', 'Setup only edits regular configuration files, not symbolic links'));
    const ensureUnchanged = async () => {
      if (await readFile(file, 'utf8') !== original) throw new Error(say(locale, '配置在预览后已被修改，请重新运行初始化', 'Configuration changed after the preview; run setup again'));
    };
    await ensureUnchanged();
    await mkdir(backupDir, { recursive: true });
    const backup = join(backupDir, `${basename(file)}.${Date.now()}-${randomUUID()}.bak`);
    await writeFile(backup, original, { flag: 'wx', mode: info.mode });
    await writeFile(tempPath, next, { flag: 'wx', mode: info.mode });
    await ensureUnchanged();
    await rename(tempPath, file);
    return { changed: true, backup };
  } finally {
    await rm(tempPath, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
