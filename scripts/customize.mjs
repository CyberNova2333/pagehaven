#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCustomizer, parseCustomizeArgs, readCustomSettings } from './lib/customize.mjs';
import { CONFIG_FILE, OUT_DIR } from './lib/paths.mjs';

export async function main(args = process.argv.slice(2)) {
  const options = parseCustomizeArgs(args);
  if (options.help) {
    console.log(`页间 · 站点自定义

pnpm run customize                       在浏览器中设置名称、Logo、色调与阅读功能
pnpm run customize -- --host 0.0.0.0      在 Codespaces 中使用私有端口转发

--host <地址>          默认 127.0.0.1；另支持 localhost、0.0.0.0
--port <端口>          默认 4318
--config <路径>        配置文件；也支持 CONFIG_FILE
--help                 显示帮助

工具仅保存站点配置并备份原文件，提交并手动发布后才会对读者生效。`);
    return;
  }
  const configFile = resolve(options.config ?? (process.env.CONFIG_FILE || CONFIG_FILE));
  readCustomSettings(await readFile(configFile, 'utf8'));
  const token = randomBytes(32).toString('hex');
  const server = createCustomizer({ configFile, backupDir: join(OUT_DIR, 'customize'), token });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? '端口已被使用，请用 --port 选择其他端口。' : '配置工具无法启动，请检查监听地址与端口。');
    process.exitCode = 1;
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.removeListener('error', reject); resolveListen(); });
  });
  const displayHost = options.host === '0.0.0.0' ? '127.0.0.1' : options.host;
  console.log(`站点自定义已启动：http://${displayHost}:${options.port}/#token=${token}`);
  console.log('请使用上面的完整链接；会话凭证只在本次进程内有效，停止工具后失效。');
  if (options.host === '0.0.0.0') console.log('Codespaces 中请将此端口设为“私有”，打开转发地址并保留链接末尾的 #token= 部分。');
  console.log('保存只更新配置；提交并手动发布后才会对全部读者生效。按 Ctrl+C 退出。');
  const close = () => { server.close(); server.closeIdleConnections(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

try { await main(); } catch { console.error('配置工具未启动，请检查参数、配置文件或使用 --help。'); process.exitCode = 1; }
