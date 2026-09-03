// data/meta 的最小读取：只取 URL 结构（作品 / 期 / 话 的 id），供 check 守卫与骨架期脚本用。
// 完整 schema 校验在 @gallery/core（ARCHITECTURE §10 第 2 步）落地后由那边接管，这里不做校验。
import { readdir, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import yaml from 'js-yaml';

/**
 * @param {string} metaDir
 * @returns {Promise<Array<{series: string, issue: string, chapter: string, key: string}>>}
 */
export async function listChapters(metaDir) {
  let files;
  try {
    files = (await readdir(metaDir)).filter((f) => extname(f) === '.yaml' || extname(f) === '.yml').sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const f of files) {
    const doc = yaml.load(await readFile(join(metaDir, f), 'utf8'));
    if (!doc || typeof doc !== 'object') continue;
    const series = String(doc.id ?? basename(f, extname(f)));
    for (const issue of doc.issues ?? []) {
      for (const chapter of issue.chapters ?? []) {
        out.push({ series, issue: String(issue.id), chapter: String(chapter.id), key: `${series}/${issue.id}/${chapter.id}` });
      }
    }
  }
  return out;
}
