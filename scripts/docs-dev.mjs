import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 保留原 CLI 参数；直接启动 Node，确保 Windows/Linux 都只管理一个子进程。
export function startDocsDev(root, args = [], { stdio = 'inherit' } = {}) {
  const cliArgs = args[0] === '--' ? args.slice(1) : args;
  const require = createRequire(join(root, 'package.json'));
  const manifest = require.resolve('vitepress/package.json');
  const bin = join(dirname(manifest), require(manifest).bin.vitepress);
  let child, timer, stopping = false, restarting = false;
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  const launch = () => {
    child = spawn(process.execPath, [bin, 'dev', root, '--strictPort', ...cliArgs], {
      cwd: root,
      env: { ...process.env, PAGEHAVEN_DOCS_DEV: '1' },
      stdio: [stdio, stdio, stdio, 'ipc'],
    });
    child.on('message', (message) => {
      if (message?.type !== 'pagehaven:guide-changed' || stopping || restarting) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        restarting = true;
        child.kill();
      }, 200);
    });
    child.once('error', (error) => {
      console.error(error);
      stopping = true;
      clearTimeout(timer);
      finish(1);
    });
    child.once('exit', (code, signal) => {
      child = undefined;
      clearTimeout(timer);
      if (!stopping && restarting) {
        restarting = false;
        launch();
      } else finish(stopping ? 0 : (code ?? (signal ? 1 : 0)));
    });
  };
  launch();
  return {
    closed,
    close() {
      stopping = true;
      clearTimeout(timer);
      if (child) child.kill();
      return closed;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../docs-site/', import.meta.url));
  const dev = startDocsDev(root, process.argv.slice(2));
  const stop = () => { void dev.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.exitCode = await dev.closed;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
