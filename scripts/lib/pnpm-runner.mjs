import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';

const ENTRY_NAME = /^(?:pnpm|pnpm-native)(?:\.(?:exe|cjs|mjs|js))?$/i;
const JAVASCRIPT = /\.(?:cjs|mjs|js)$/i;
const INSTALL_HINT = '请安装 pnpm，并通过 pnpm run deploy:<目标> 启动部署';

function entryCommand(file, args, platform) {
  if (!isAbsolute(file) || !ENTRY_NAME.test(basename(file))) return null;
  let entry;
  try {
    entry = realpathSync(file);
    if (!statSync(entry).isFile() || !ENTRY_NAME.test(basename(entry))) return null;
    accessSync(entry, JAVASCRIPT.test(entry) ? constants.R_OK : constants.X_OK);
  } catch { return null; }
  if (JAVASCRIPT.test(entry)) return { command: process.execPath, args: [entry, ...args] };
  // Windows 的无扩展名文件通常是 shell shim；只直接执行原生 .exe。
  if (platform === 'win32' && extname(entry).toLowerCase() !== '.exe') return null;
  return { command: entry, args: [...args] };
}

/** 将 pnpm 自身的入口转换为无需 shell 的命令；拒绝把其他包管理器冒充为 pnpm。 */
export function resolvePnpmCommand(args, { env = process.env, platform = process.platform } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('pnpm 参数必须是字符串数组');
  }
  if (env.npm_execpath) {
    const command = entryCommand(env.npm_execpath, args, platform);
    if (command) return command;
    throw new Error(`当前包管理器入口不是可运行的 pnpm JavaScript 或原生文件；${INSTALL_HINT}`);
  }

  // Node 在 Windows 以字典序选择大小写不敏感的 PATH 键，保持相同选择。
  const pathKey = platform === 'win32'
    ? Object.keys(env).sort().find((key) => key.toLowerCase() === 'path')
    : 'PATH';
  const directories = String(env[pathKey] || '').split(platform === 'win32' ? ';' : ':');
  for (const value of directories) {
    const directory = value.replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(directory)) continue;
    const candidates = [
      ...(platform === 'win32' ? ['pnpm.exe', 'pnpm-native.exe'] : ['pnpm', 'pnpm-native']),
      'pnpm.cjs', 'pnpm.mjs', 'pnpm.js',
      // npm/Corepack 的 Windows shim 不能直接 spawn，也不能将部署参数交给 cmd.exe。
      'node_modules/corepack/dist/pnpm.js',
      'node_modules/pnpm/bin/pnpm.cjs',
    ];
    for (const candidate of candidates) {
      const command = entryCommand(join(directory, candidate), args, platform);
      if (command) return command;
    }
  }
  throw new Error(`找不到可直接启动的 pnpm 入口；${INSTALL_HINT}`);
}
