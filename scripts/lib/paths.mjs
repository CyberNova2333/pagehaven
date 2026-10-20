// 仓库内的固定路径。所有脚本从这里取，不各自拼相对路径。
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 数据目录。DATA_DIR 环境变量可指向别处（CI 用测试样本全量空跑时用）。 */
export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data');
export const META_DIR = join(DATA_DIR, 'meta');
export const TEXT_DIR = join(DATA_DIR, 'text');
/** 站点静态产物（每话一 HTML、索引分片、sitemap）。DIST_DIR 环境变量可覆盖（测试往临时目录建）。 */
export const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : join(ROOT, 'dist');
/** 非 dist 的产物：manifest.json、db/、site-<date>.tar.zst。OUT_DIR 环境变量可覆盖。 */
export const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(ROOT, 'out');
export const OUT_DB_DIR = join(OUT_DIR, 'db');
export const SITE_DIR = join(ROOT, 'packages', 'site');
export const SITE_GENERATED_DIR = join(SITE_DIR, 'src', 'generated');
export const PLATFORM_GENERATED_DIR = join(ROOT, 'packages', 'platform', 'generated');
/** 流水线配置（CNB 云原生构建；仓库里唯一的一份，不用 .github/workflows）。 */
export const CNB_FILE = join(ROOT, '.cnb.yml');
export const CNB_DIR = join(ROOT, '.cnb');
/** 已经迁走的旧载体。守卫拿它防回潮：存在就说明有两份流水线真相。 */
export const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
export const CONFIG_FILE = join(ROOT, 'site.config.yaml');
