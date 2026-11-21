// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 仓库内的固定路径。所有脚本从这里取，不各自拼相对路径。
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 数据目录。DATA_DIR 环境变量可指向别处（CI 用测试样本全量空跑时用）。 */
export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data');
export const META_DIR = join(DATA_DIR, 'meta');
export const TEXT_DIR = join(DATA_DIR, 'text');
/** 同时构建时每个任务指定一个独占目录，各阶段在同一目录读写。 */
export const BUILD_WORK_DIR = process.env.BUILD_WORK_DIR ? resolve(process.env.BUILD_WORK_DIR) : null;
const outputRoot = BUILD_WORK_DIR ?? ROOT;
/** 站点静态产物（每话一 HTML、索引分片、sitemap）。DIST_DIR 环境变量可覆盖（测试往临时目录建）。 */
export const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : join(outputRoot, 'dist');
/** 非 dist 的产物：manifest.json、db/、site-<date>.tar.zst。OUT_DIR 环境变量可覆盖。 */
export const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(outputRoot, 'out');
export const OUT_DB_DIR = join(OUT_DIR, 'db');
export const SITE_DIR = join(ROOT, 'packages', 'site');
export const SITE_GENERATED_DIR = BUILD_WORK_DIR ? join(BUILD_WORK_DIR, 'site-generated') : join(SITE_DIR, 'src', 'generated');
export const PLATFORM_GENERATED_DIR = BUILD_WORK_DIR ? join(BUILD_WORK_DIR, 'platform-generated') : join(ROOT, 'packages', 'platform', 'generated');
// 入库模板使用平台默认相对路径。隔离模板则相对本次模板目录定位实际 dist。
export const TEMPLATE_ASSETS_DIRECTORY = BUILD_WORK_DIR
  ? relative(PLATFORM_GENERATED_DIR, DIST_DIR).split(sep).join('/') || '.'
  : undefined;
/** 实际执行的 GitHub Actions 工作流目录。 */
export const WORKFLOW_DIR = join(ROOT, '.github', 'workflows');
export const CONFIG_FILE = join(ROOT, 'site.config.yaml');
