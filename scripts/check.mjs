#!/usr/bin/env node
// `npm run check` —— 提交前必过的守卫（CLAUDE.md 铁律 4）。
//
// 守的每一条都对应一条铁律或一个平台上限，数字的来历见 docs/ARCHITECTURE.md §2「预算」：
//
//   1. site.config.yaml 合法，且 DB 的 page_size == 检索端 requestChunkSize（铁律 4）
//   2. _headers / _redirects / edgeone.json 与 site.config.yaml 同步（铁律 5）
//   3. packages/{core,site,search} 只用 Web 标准 API：无 node: 导入、无 Node 内置模块、
//      无原生依赖、不出现对象存储直连域名（铁律 1、7）；
//      依赖树里没有 sharp/libvips（LGPL）、站点图片服务仍是 noop（CONTRIBUTING §二之三）
//   4. 流水线（CNB .cnb.yml）：没有 crontab，只有 main 的 push 跑检查，发布只 web_trigger（铁律 6）
//   5. data/ 合法：meta 与 text 过 schema、互相对得上（铁律 8：数据唯一来源是 R2 + data/）
//   6. dist：文件数 ≤ 18 000、单文件 ≤ 20 MB、没有图片和 DB、每话恰好一个 HTML（铁律 4）；
//      sitemap 覆盖每一话（sitemap.xml 是 index 就跟进它指向的各分片，每片 ≤ 协议上限 50 000 条）；
//      seo.indexnow_key 非空时 dist/<key>.txt 存在且内容逐字节等于 key（IndexNow 协议按字节比对）
//   7. out/db 里的 sqlite：文件头里的 page_size 与配置一致；chunks.json 的块大小一致
//   8. lint
//   9. 双语 README 的章节链接与实际标题生成的 CNB 锚点一致
//
// 输出给手机上看构建日志的人：每节一个 ✔/✘，问题逐条列出，最后一行给结论。
// 任何一节失败退出码都是 1，但所有节都会跑完——一次看全，不用来回改。
import { readdir, readFile, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname, basename, sep } from 'node:path';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { generateAll, DEPLOY_TARGETS, DEFAULT_RELEASE_TARGETS, DEPLOY_CONFIG_FILES } from '@gallery/platform';
import { hasDeploymentCommand } from './lib/pipeline-policy.mjs';
import { inspectDeploymentFiles, validateDeploymentBudget } from './lib/deploy-budget.mjs';
import { isDeploymentProofPath } from './lib/deploy-proof.mjs';
import { loadSiteConfig } from './lib/config.mjs';
import { loadGallery } from './lib/data.mjs';
import { ROOT, DATA_DIR, DIST_DIR, OUT_DB_DIR, PLATFORM_GENERATED_DIR, CNB_FILE, CNB_DIR } from './lib/paths.mjs';
import { parseSitemap, indexNowKeyFile, SITEMAP_FILE, SITEMAP_PROTOCOL_MAX_URLS } from './lib/sitemap.mjs';
import { step, ok, fail, note, warn } from './lib/log.mjs';
import { checkReadmeLinks } from './lib/readme-links.mjs';

const WEB_ONLY_PACKAGES = ['core', 'site', 'search'];
const IMAGE_OR_DB_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp', '.tif', '.tiff', '.sqlite', '.sqlite3', '.db', '.zst']);
const NATIVE_DEP_BLOCKLIST = new Set(['better-sqlite3', 'sqlite3', 'sharp', 'canvas', 'node-gyp', 'bufferutil', 'utf-8-validate', 'fsevents', 'node-addon-api']);
// 对象存储的直连端点。铁律 7：读一律走 CDN 域名，站点与浏览器不该知道存储的存在。
// 只钉「端点后缀」这种平台形态，不钉任何账号、桶名（CONTRIBUTING §二之二）。
const STORAGE_DIRECT_HOST = /r2\.cloudflarestorage\.com/;

let failures = 0;
const rel = (p) => relative(ROOT, p).split(sep).join('/');

async function section(title, fn) {
  step(title);
  let problems;
  try {
    problems = (await fn()) ?? [];
  } catch (e) {
    problems = [`守卫自身出错：${e.message}`];
  }
  if (problems.length === 0) {
    ok('通过');
  } else {
    failures += 1;
    for (const p of problems) fail(p);
  }
}

async function walk(dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

let config = null;
let gallery = null;

// ── 1. 配置 ────────────────────────────────────────────────────────
await section('site.config.yaml', async () => {
  try {
    config = await loadSiteConfig();
  } catch (e) {
    return [e.message];
  }
  note(`page_size=${config.db.page_size} requestChunkSize=${config.search.request_chunk_size} chunk_size=${config.db.chunk_size}`);
  return [];
});

// ── 2. 配置生成物同步 ───────────────────────────────────────────────
await section('配置生成物与 site.config.yaml 同步', async () => {
  if (!config) return ['配置不合法，跳过'];
  const problems = [];
  const expected = await generateAll(config);
  for (const [name, content] of Object.entries(expected)) {
    const p = join(PLATFORM_GENERATED_DIR, name);
    if (!existsSync(p)) {
      problems.push(`${rel(p)} 不存在——跑 npm run build:config`);
      continue;
    }
    const actual = await readFile(p, 'utf8');
    if (actual !== content) problems.push(`${rel(p)} 与 site.config.yaml 不同步——不要手改它，改 site.config.yaml 后跑 npm run build:config`);
  }
  return problems;
});

// ── 3. 平台无关代码只用 Web 标准 API ────────────────────────────────
await section('packages/{core,site,search} 无 Node 内置模块 / 原生依赖', async () => {
  const problems = [];
  const builtins = new Set(builtinModules);
  const specRe = /(?:^|[^\w$.])(?:import\s*(?:[\w${},*\s]+from\s*)?|export\s*[\w${},*\s]+from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const pkg of WEB_ONLY_PACKAGES) {
    const dir = join(ROOT, 'packages', pkg);
    const src = join(dir, 'src');
    if (existsSync(src)) {
      for (const file of await walk(src)) {
        if (!['.js', '.mjs', '.ts', '.astro'].includes(extname(file))) continue;
        if (rel(file).startsWith('packages/site/src/generated/')) continue;
        const text = await readFile(file, 'utf8');
        for (const m of text.matchAll(specRe)) {
          const spec = m[1];
          if (spec.startsWith('node:') || builtins.has(spec)) {
            problems.push(`${rel(file)} 导入了 Node 内置模块 '${spec}'（铁律 1：平台无关代码只用 Web 标准 API；Node 只许出现在 scripts/）`);
          }
        }
        if (STORAGE_DIRECT_HOST.test(text)) {
          problems.push(`${rel(file)} 出现了对象存储直连端点（铁律 7：读一律走 CDN 域名）`);
        }
      }
    }
    const pkgJson = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      if (NATIVE_DEP_BLOCKLIST.has(dep)) {
        problems.push(`packages/${pkg} 依赖了原生模块 ${dep}（铁律 1：sqlite 一律 sql.js，不引原生依赖）`);
        continue;
      }
      const depDir = join(ROOT, 'node_modules', dep);
      if (!existsSync(depDir)) continue; // 没装（npm ci 之前）就不查；CI 一定装了
      let depPkg = {};
      try {
        depPkg = JSON.parse(await readFile(join(depDir, 'package.json'), 'utf8'));
      } catch {
        /* 没有 package.json 的目录不是包 */
      }
      if (depPkg.gypfile || existsSync(join(depDir, 'binding.gyp'))) {
        problems.push(`packages/${pkg} 的依赖 ${dep} 带原生构建（binding.gyp）（铁律 1）`);
      }
    }
  }
  return problems;
});

// ── 3b. 依赖树的许可证底线（CONTRIBUTING §二之三）─────────────────────
await section('依赖树：非宽松许可证只许出现在构建期工具链里', async () => {
  const problems = [];
  const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  const entries = lock.packages ?? {};

  // sharp 是 `astro` 的可选依赖，跟着默认图片服务一起进来，带一批 LGPL 的 libvips 二进制。
  // 站点不做构建期图像处理（图片全走 CDN），所以它不该出现在树里：换 noop 服务 + 从 lock 里摘掉。
  // 按许可证判定，不按包名：@img/colour 挂在同一个 scope 下但它是 MIT，不算。
  const sharpish = Object.entries(entries).filter(
    ([k, v]) => v?.license && /LGPL/i.test(v.license) && (k === 'node_modules/sharp' || k.startsWith('node_modules/@img/')),
  );
  if (sharpish.length > 0) {
    problems.push(
      `lock 里有 ${sharpish.length} 个 sharp/libvips 条目（LGPL）：站点不做构建期图像处理，` +
        `图片服务必须是 astro/assets/services/noop，且 sharp 不该在 lock 里（CONTRIBUTING §二之三）`,
    );
  }

  // 图片服务一旦改回默认（sharp），下一个人 npm ci 就把 LGPL 装回来了。
  const astroConfig = await readFile(join(ROOT, 'packages', 'site', 'astro.config.mjs'), 'utf8');
  if (!astroConfig.includes('astro/assets/services/noop')) {
    problems.push('packages/site/astro.config.mjs 没把 image.service 指向 noop：默认的 sharp 会带 LGPL 的 libvips 进树');
  }
  return problems;
});

// ── 4. 流水线（CNB）──────────────────────────────────────────────────
await section('流水线：main 的 push 只跑检查，发布只手动，没有定时（铁律 6）', async () => {
  if (!existsSync(CNB_FILE)) return ['.cnb.yml 不存在——流水线配置必须入库'];
  let doc;
  try {
    doc = yaml.load(await readFile(CNB_FILE, 'utf8'));
  } catch (e) {
    return [`.cnb.yml 解析失败：${e.message}`];
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['.cnb.yml 顶层应是「分支 → 事件」的对象'];

  const problems = [];
  const MANUAL_EVENT = /^web_trigger(_|$)/;
  const manualEvents = new Set();
  let pushPipelines = 0;

  for (const [branch, events] of Object.entries(doc)) {
    if (branch.startsWith('.')) continue; // YAML 锚点之类的复用片段
    if (!events || typeof events !== 'object' || Array.isArray(events)) {
      problems.push(`${branch} 下应是「事件 → 流水线」的对象`);
      continue;
    }
    for (const [event, pipelines] of Object.entries(events)) {
      if (event.includes('crontab')) {
        problems.push(`${branch}.${event}：定时触发被禁（铁律 6：仓库无活动后平台会停用，弃维护场景等于埋雷）`);
        continue;
      }
      if (event === 'push') {
        pushPipelines += 1;
        if (branch !== 'main') problems.push(`${branch}.push：只有 main 允许自动跑（AGENTS.md §0 / §2）`);
        if (!Array.isArray(pipelines) || pipelines.length !== 1) {
          problems.push(`${branch}.push：应恰好一条流水线（检查），现在是 ${Array.isArray(pipelines) ? pipelines.length : '非数组'}`);
          continue;
        }
        const text = JSON.stringify(pipelines[0]);
        for (const needle of ['npm run check', 'npm test', 'npm run build']) {
          if (!text.includes(needle)) problems.push(`${branch}.push：检查流水线里没有 \`${needle}\`——push 触发的流水线只能是检查类`);
        }
        if (hasDeploymentCommand(text)) {
          problems.push(`${branch}.push：出现发布/部署步骤——发布只能手动（铁律 6）`);
        }
        continue;
      }
      if (MANUAL_EVENT.test(event)) {
        manualEvents.add(event);
        continue;
      }
      problems.push(`${branch}.${event}：会自动触发——本仓库只允许 push（仅 main、仅检查）与 web_trigger（手动）`);
    }
  }
  if (pushPipelines === 0) problems.push('没有 main 的 push 检查流水线：推上去就没人复验');
  if (manualEvents.size === 0) problems.push('没有 web_trigger 手动流水线：页面上没有发布入口');

  // 按钮 → 事件必须有对应流水线；配错了平台只会让按钮点了没反应
  const triggerFile = join(CNB_DIR, 'web_trigger.yml');
  if (!existsSync(triggerFile)) {
    problems.push('.cnb/web_trigger.yml 不存在——发布按钮没了');
  } else {
    let trigger = null;
    try {
      trigger = yaml.load(await readFile(triggerFile, 'utf8'));
    } catch (e) {
      problems.push(`.cnb/web_trigger.yml 解析失败：${e.message}`);
    }
    if (trigger && Array.isArray(trigger.branch)) {
      for (const group of trigger.branch) {
        for (const button of group?.buttons ?? []) {
          const event = button?.event;
          if (!manualEvents.has(event)) {
            problems.push(`web_trigger.yml：按钮「${button?.name ?? '?'}」的事件 ${JSON.stringify(event)} 在 .cnb.yml 里没有定义`);
          }
          if (event === 'web_trigger_release') {
            const choices = button?.inputs?.target?.options ?? [];
            const values = choices.map((choice) => choice.value);
            for (const target of ['none', 'all', ...DEPLOY_TARGETS]) {
              if (!values.includes(target)) problems.push(`发布按钮缺少目标 ${target}`);
            }
          }
        }
      }
    }
  }

  return problems;
});

// ── 5. data/ ─────────────────────────────────────────────────────────
await section('data/：meta 与 text 过 schema 且互相对得上', async () => {
  if (!config) return ['配置不合法，跳过'];
  try {
    gallery = await loadGallery({ dataDir: DATA_DIR, imagePrefix: config.images.prefix });
  } catch (e) {
    return e.issues ?? [e.message];
  }
  const t = gallery.totals;
  note(`${rel(DATA_DIR)}：${t.series} 个作品、${t.issues} 期、${t.chapters} 话、${t.pages} 页、${t.boxes} 个台词框`);
  return [];
});

// ── 6. dist 预算 ─────────────────────────────────────────────────────
await section('dist：文件数 / 单文件大小 / 无图片与 DB / 每话恰好一个 HTML / sitemap 覆盖每话 / IndexNow key 文件', async () => {
  if (!config) return ['配置不合法，跳过'];
  if (!gallery) return ['data/ 不合法，跳过'];
  const selected = process.env.DEPLOY_TARGET || 'none';
  if (!['none', 'all', ...DEPLOY_TARGETS].includes(selected)) return ['DEPLOY_TARGET 不是已注册目标'];
  if (!existsSync(DIST_DIR)) {
    if (selected !== 'none') return ['发布前必须存在完整 dist，请先运行完整构建'];
    warn('dist/ 不存在（尚未 npm run build），产物守卫跳过——CI 会在 build 之后再跑一遍');
    return [];
  }
  const problems = [];
  const files = await walk(DIST_DIR);
  note(`dist 文件数 ${files.length} / ${config.budgets.max_files}`);
  if (files.length > config.budgets.max_files) {
    problems.push(`dist 文件数 ${files.length} 超过仓库预算 ${config.budgets.max_files}（目标平台还可能有更小限制；是不是每页一个 HTML 了？）`);
  }
  let biggest = 0;
  for (const f of files) {
    const s = await stat(f);
    biggest = Math.max(biggest, s.size);
    if (s.size > config.budgets.max_file_bytes) problems.push(`${rel(f)} 有 ${s.size} 字节，超过 ${config.budgets.max_file_bytes}`);
    if (IMAGE_OR_DB_EXT.has(extname(f).toLowerCase())) problems.push(`${rel(f)}：图片与 DB 不进 dist（它们在对象存储，经 CDN 读）`);
    if (DEPLOY_CONFIG_FILES.includes(basename(f))) problems.push(`${rel(f)}：部署控制文件不得进入公开静态产物`);
    if (isDeploymentProofPath(relative(DIST_DIR, f).split(sep).join('/'))) problems.push(`${rel(f)}：部署验证保留路径只能出现在临时上传副本`);
  }
  note(`最大单文件 ${biggest} 字节 / ${config.budgets.max_file_bytes}`);

  // 发布检查发生在上传前；all 取四平台预算交集，不把 ESA 超额留到上传之后才发现。
  if (selected !== 'none') {
    const inventory = await inspectDeploymentFiles(DIST_DIR);
    for (const target of selected === 'all' ? DEFAULT_RELEASE_TARGETS : [selected]) {
      problems.push(...validateDeploymentBudget({ target, config, files: inventory }));
    }
  }

  for (const c of gallery.chapters) {
    const dir = join(DIST_DIR, c.seriesId, c.issueId, c.id);
    if (!existsSync(join(dir, 'index.html'))) {
      problems.push(`${c.key} 没有生成 ${rel(join(dir, 'index.html'))}`);
      continue;
    }
    const htmls = (await walk(dir)).filter((f) => extname(f) === '.html');
    if (htmls.length !== 1) {
      problems.push(`${c.key} 下有 ${htmls.length} 个 HTML，应恰好一个（阅读器内翻页，#p12 深链，不做每页一 HTML）：${htmls.map(rel).join(', ')}`);
    }
  }

  // sitemap 覆盖每一话：话是站点的主体，漏一话搜索引擎就永远不知道它。sitemap.xml 是 index 时把它指向的
  // 各分片都读进来；每片顺带核对协议上限。只用正则抓 <loc>（parseSitemap）——文件是自己生成的、形状固定，
  // 守卫不该为一次核对多拉一个 XML 解析依赖
  const origin = `https://${config.site.domain}`;
  const sitemapPath = join(DIST_DIR, SITEMAP_FILE);
  if (!existsSync(sitemapPath)) {
    problems.push(`${rel(sitemapPath)} 不存在——跑 npm run build:sitemap`);
  } else {
    let top = null;
    try {
      top = parseSitemap(await readFile(sitemapPath, 'utf8'));
    } catch (e) {
      problems.push(`${rel(sitemapPath)}：${e.message}`);
    }
    /** @type {{ path: string, locs: string[] }[]} */
    const shards = [];
    if (top && !top.index) shards.push({ path: sitemapPath, locs: top.locs });
    if (top?.index) {
      for (const loc of top.locs) {
        // index 里的分片是绝对 URL，只认本站的，按路径映射回 dist 里的文件
        const segs = loc.startsWith(`${origin}/`) ? loc.slice(origin.length + 1).split('/') : null;
        if (!segs || segs.some((s) => s === '' || s === '.' || s === '..')) {
          problems.push(`${rel(sitemapPath)} 指向站外或形状不对的分片：${loc}`);
          continue;
        }
        const p = join(DIST_DIR, ...segs);
        if (!existsSync(p)) {
          problems.push(`${rel(sitemapPath)} 指向的分片 ${loc} 在 dist 里不存在（${rel(p)}）`);
          continue;
        }
        try {
          const shard = parseSitemap(await readFile(p, 'utf8'));
          if (shard.index) problems.push(`${rel(p)} 又是一个 sitemap index（协议不允许嵌套）`);
          else shards.push({ path: p, locs: shard.locs });
        } catch (e) {
          problems.push(`${rel(p)}：${e.message}`);
        }
      }
    }
    const locs = new Set();
    for (const s of shards) {
      if (s.locs.length > SITEMAP_PROTOCOL_MAX_URLS) problems.push(`${rel(s.path)} 有 ${s.locs.length} 条 URL，超过协议上限 ${SITEMAP_PROTOCOL_MAX_URLS}`);
      for (const l of s.locs) locs.add(l);
    }
    if (top) {
      // 顶层都解析不了时不逐话点名：那只会把同一个原因重复几千遍
      for (const c of gallery.chapters) if (!locs.has(origin + c.url)) problems.push(`sitemap 缺 ${c.key}（${origin + c.url}）`);
      note(`sitemap：${shards.length} 个文件、${locs.size} 条 URL${top.index ? '（index 形态）' : ''}`);
    }
  }

  // IndexNow key 文件：协议按字节比对 https://<domain>/<key>.txt 与 key，连末尾换行都不能有
  const keyFile = indexNowKeyFile(config);
  if (keyFile) {
    const p = join(DIST_DIR, keyFile.name);
    if (!existsSync(p)) problems.push(`${rel(p)} 不存在（seo.indexnow_key 非空时 build:sitemap 会写它）`);
    else if ((await readFile(p, 'utf8')) !== keyFile.content) problems.push(`${rel(p)} 的内容与 seo.indexnow_key 不同（协议逐字节比对，末尾不能有换行）`);
  }
  return problems;
});

// ── 7. 检索库 page_size ─────────────────────────────────────────────
await section('out/db：sqlite page_size 与分块大小同配置', async () => {
  if (!config) return ['配置不合法，跳过'];
  if (!existsSync(OUT_DB_DIR)) {
    note('out/db/ 不存在（尚未 build:db），跳过');
    return [];
  }
  const problems = [];
  for (const f of (await readdir(OUT_DB_DIR)).filter((f) => f.endsWith('.sqlite'))) {
    const p = join(OUT_DB_DIR, f);
    const fh = await open(p, 'r');
    const head = Buffer.alloc(100);
    await fh.read(head, 0, 100, 0);
    await fh.close();
    if (head.toString('latin1', 0, 16) !== 'SQLite format 3\0') {
      problems.push(`${rel(p)} 不是 sqlite 文件`);
      continue;
    }
    const raw = head.readUInt16BE(16);
    const pageSize = raw === 1 ? 65536 : raw;
    if (pageSize !== config.db.page_size) problems.push(`${rel(p)} 的 page_size 是 ${pageSize}，配置是 ${config.db.page_size}（检索端按 requestChunkSize 取块，两者必须一致）`);
    const chunksPath = `${p}.chunks.json`;
    if (!existsSync(chunksPath)) {
      problems.push(`${rel(p)} 缺同名 .chunks.json（ARCHITECTURE §6：逐块摘要与 DB 同版本产出）`);
      continue;
    }
    const chunks = JSON.parse(await readFile(chunksPath, 'utf8'));
    if (chunks.chunkSize !== config.db.chunk_size) problems.push(`${rel(chunksPath)} 的 chunkSize 是 ${chunks.chunkSize}，配置是 ${config.db.chunk_size}`);
    const size = (await stat(p)).size;
    if (chunks.totalBytes !== size) problems.push(`${rel(chunksPath)} 记录总长 ${chunks.totalBytes}，文件实际 ${size}`);
  }
  return problems;
});

// ── 8. lint ─────────────────────────────────────────────────────────
await section('lint', async () => {
  const eslint = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!existsSync(eslint)) return ['eslint 没装——先 npm ci'];
  const r = spawnSync(process.execPath, [eslint, '.'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) return [];
  return [(r.stdout || '') + (r.stderr || '')];
});

// ── 9. README 章节链接 ──────────────────────────────────────────────
await section('双语 README 的章节链接与实际 CNB 标题锚点一致', async () => {
  const problems = [];
  for (const file of ['README.md', 'README.en.md']) {
    problems.push(...checkReadmeLinks(await readFile(join(ROOT, file), 'utf8'), file));
  }
  return problems;
});

console.log('');
if (failures) {
  fail(`check：${failures} 节未通过（规则出处见 CLAUDE.md 铁律与 docs/ARCHITECTURE.md §2）`);
  process.exit(1);
}
ok('check：全部通过');
