// STATUS.md 的渲染（纯函数）。
//
// STATUS.md 是弃维护后别人接手的入口（铁律 10）：从它要能知道线上是哪个版本、部署在哪、
// 数据在哪。所以渲染只做一件事——把 write-status.mjs 收集好的事实排成固定形状的表；
// 收集（读 manifest、数 dist、列对象存储）在脚本里，这里不碰文件与网络，能直接单测每个分支。
//
// 表格的行固定不变：接手的人（或将来的脚本）按行名找值。没有的值一律写「—」，
// 不省略行。对象存储里的东西只写 key 与大小——账号、桶名永远不出现在这个文件里（铁律 7）。

/**
 * @typedef {object} StatusData
 * @property {string} version          本次发布的版本号
 * @property {string} target           部署目标（发布流水线的 target 输入）
 * @property {string} domain           站点域名（来自 manifest / site.config.yaml）
 * @property {string} writtenAt        ISO 8601（UTC）
 * @property {string|null} runUrl      本次发布运行的链接；拿不到构建页时为 null
 * @property {number|null} distFiles   dist 文件数；dist 不存在为 null
 * @property {StatusDb|null} db        manifest.db；build:db 没跑为 null
 * @property {StatusStorage|null} storage  对象存储实际清单；没有凭据（没列）或列举失败为 null
 * @property {string|null} [storageError]  有凭据但列举失败的原因（脚本已抹掉账号 / 桶名 / 端点）；
 *   成功或没列为 null
 * @property {number|null} durationMs  本次发布耗时；拿不到为 null
 */
/**
 * @typedef {{ key: string, size: number, sha256?: string, chunks?: string, version?: string }} StatusDb
 */
/**
 * @typedef {{ dbPrefix: string, dbObjects: { key: string, size: number }[], imageObjects: number }} StatusStorage
 */

const DASH = '—';

/** 千分位：手机上看 12 345 678 比 12345678 好数得多。 */
export function formatBytes(n) {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} 字节`;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 表格单元格里不能有换行与竖线，其它照写。 */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * @param {StatusData} data
 * @returns {string}
 */
export function renderStatus(data) {
  let db = '（尚未构建）';
  if (data.db) {
    const sha = data.db.sha256 ? `，sha256 \`${data.db.sha256.slice(0, 12)}…\`` : '';
    db = `\`${data.db.key}\`（${formatBytes(data.db.size)}${sha}）`;
  }
  let storage = `${DASH}（无对象存储凭据，未列出）`;
  if (data.storageError) {
    // 列举失败也是一条事实：留着上次的清单反而让人以为一切正常
    storage = `列出失败：${data.storageError}`;
  } else if (data.storage) {
    const { dbPrefix, dbObjects, imageObjects } = data.storage;
    storage = `\`${dbPrefix}\` 下 ${dbObjects.length} 个对象（清单见下）；图片对象 ${imageObjects} 个`;
  }
  const domain = data.domain
    ? `\`${data.domain}\`（只在 \`site.config.yaml\` 的 \`site.domain\` 改）`
    : '见 `site.config.yaml` 的 `site.domain`';
  const rows = [
    ['版本', data.version || DASH],
    ['当前部署目标', data.target || DASH],
    ['站点域名', domain],
    ['检索库', db],
    ['dist 文件数', data.distFiles == null ? DASH : String(data.distFiles)],
    ['对象存储对象清单', storage],
    ['最近一次发布耗时', data.durationMs == null ? DASH : formatDuration(data.durationMs)],
    ['写入时间（UTC）', data.writtenAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')],
    ['发布运行', data.runUrl ? `[${data.runUrl.split('/').pop()}](${data.runUrl})` : DASH],
  ];
  const lines = [
    '# STATUS.md — 当前状态',
    '',
    '> 本文件由 `.cnb.yml` 的发布流水线在每次发布末尾自动写入（CLAUDE.md 铁律 10），**不手改**。',
    '> 它是弃维护后别人接手的入口：从这里能知道线上是哪个版本、部署在哪、数据在哪。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`),
    '',
  ];
  if (data.storage && !data.storageError) {
    // 检索库的历次版本都留在存储里（ARCHITECTURE §8：数据不能只存在一个账号里，也不能只有一份）；
    // 哪一份是线上正在用的，靠 manifest 的 db 字段——这里标出来，接手的人不用猜
    lines.push('## 对象存储里的检索库', '', '| key | 大小 | |', '|---|---|---|');
    if (data.storage.dbObjects.length === 0) lines.push(`| ${DASH} | ${DASH} | |`);
    for (const o of data.storage.dbObjects) {
      const mark = data.db && (o.key === data.db.key || o.key === data.db.chunks) ? '当前' : '';
      lines.push(`| \`${cell(o.key)}\` | ${formatBytes(o.size)} | ${mark} |`);
    }
    lines.push('');
  }
  lines.push('重建步骤见 [README.md](README.md)「十分钟重建」。', '');
  return lines.join('\n');
}
