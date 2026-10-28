// 独立内容检查复用构建入口，覆盖率只描述已入库台词，不把缺稿或空白页当作错误。
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadGallery } from './data.mjs';
import { DATA_DIR } from './paths.mjs';

export function failedDataReport(dataDir, issues) {
  return { ok: false, dataDir: resolve(dataDir), totals: null, coverage: null, missingText: [], emptyText: [], issues };
}

export async function checkData({ dataDir = DATA_DIR } = {}) {
  const directory = resolve(dataDir);
  try {
    let info;
    try {
      info = await stat(directory);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error(`数据目录不存在：${directory}`, { cause: error });
      throw error;
    }
    if (!info.isDirectory()) throw new Error(`数据路径不是目录：${directory}`);
    const gallery = await loadGallery({ dataDir: directory });
    const missingText = [];
    const emptyText = [];
    let searchableChapters = 0;
    let searchablePages = 0;
    let searchableBoxes = 0;
    for (const chapter of gallery.chapters) {
      let chapterBoxes = 0;
      for (const page of chapter.pages) {
        const boxes = page.boxes.filter((box) => box.tn.trim().length > 0).length;
        if (boxes > 0) searchablePages += 1;
        chapterBoxes += boxes;
      }
      searchableBoxes += chapterBoxes;
      if (chapterBoxes > 0) searchableChapters += 1;
      if (!chapter.hasText) missingText.push(chapter.key);
      else if (chapterBoxes === 0) emptyText.push(chapter.key);
    }
    return {
      ok: true,
      dataDir: directory,
      totals: gallery.totals,
      coverage: {
        withText: gallery.totals.chapters - missingText.length,
        withoutText: missingText.length,
        searchableChapters,
        searchablePages,
        searchableBoxes,
      },
      missingText,
      emptyText,
      issues: [],
    };
  } catch (error) {
    return failedDataReport(directory, error.issues ?? [error.message]);
  }
}
