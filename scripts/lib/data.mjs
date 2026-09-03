// 读 data/meta + data/text，校验，组装成内存模型。构建期唯一的数据入口。
//
// 一次把所有问题列全再抛：维护者在手机上看 Actions 日志，来回改一条报一条太折磨。
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import yaml from 'js-yaml';
import { buildGallery, parseSeriesMeta, parseChapterText } from '@gallery/core';
import { DATA_DIR } from './paths.mjs';

async function walk(dir, out = []) {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

/**
 * @param {{dataDir?: string, imagePrefix?: string}} [opts]
 * @returns {Promise<import('@gallery/core').Gallery & {problems: never}>}
 */
export async function loadGallery({ dataDir = DATA_DIR, imagePrefix = 'img/' } = {}) {
  const metaDir = join(dataDir, 'meta');
  const textDir = join(dataDir, 'text');
  const problems = [];
  const seriesList = [];
  const metaFiles = (await walk(metaDir)).filter((f) => ['.yaml', '.yml'].includes(extname(f))).sort();
  for (const f of metaFiles) {
    const source = relative(dataDir, f);
    let raw;
    try {
      raw = yaml.load(await readFile(f, 'utf8'));
    } catch (e) {
      problems.push(`${source}: YAML 解析失败：${e.message}`);
      continue;
    }
    try {
      const meta = parseSeriesMeta(raw, { source });
      const expected = basename(f, extname(f));
      if (meta.id !== expected) problems.push(`${source}: id（${meta.id}）必须与文件名（${expected}）一致`);
      seriesList.push(meta);
    } catch (e) {
      problems.push(...(e.issues ?? [e.message]));
    }
  }
  const texts = new Map();
  for (const f of (await walk(textDir)).filter((f) => extname(f) === '.json').sort()) {
    const source = relative(dataDir, f);
    let raw;
    try {
      raw = JSON.parse(await readFile(f, 'utf8'));
    } catch (e) {
      problems.push(`${source}: JSON 解析失败：${e.message}`);
      continue;
    }
    try {
      const text = parseChapterText(raw, { source });
      const expectedKey = relative(textDir, f).replace(/\\/g, '/').replace(/\.json$/, '');
      if (text.chapter !== expectedKey) problems.push(`${source}: chapter（${text.chapter}）必须与路径（${expectedKey}）一致`);
      if (texts.has(text.chapter)) problems.push(`${source}: chapter ${text.chapter} 重复`);
      texts.set(text.chapter, text);
    } catch (e) {
      problems.push(...(e.issues ?? [e.message]));
    }
  }
  if (problems.length) {
    const err = new Error(`data/ 不合法（共 ${problems.length} 处）：\n  · ${problems.join('\n  · ')}`);
    err.issues = problems;
    throw err;
  }
  return buildGallery(seriesList, texts, { imagePrefix });
}
