import process from 'node:process';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// VitePress 2.0.0-alpha.21 的增量索引不会删除旧章节，也不重建外部 include。
// 复用 Vite 的监听器，只通知 docs:dev 启动器；全新进程负责清除索引及渲染缓存。
export function guideSearchRefresh() {
  let dispose;
  return {
    name: 'pagehaven:guide-search-refresh',
    apply: 'serve',
    configureServer(server) {
      if (process.env.PAGEHAVEN_DOCS_DEV !== '1' || !process.send) return;
      // 可能在配置加载完成之前，启动器就已退出。
      if (!process.connected) process.exit();
      const docs = server.config.root;
      const guide = resolve(docs, '../repo-docs');
      const within = (root, file) => {
        const path = relative(root, file);
        return path && !isAbsolute(path) && !path.split(sep).some((part) => ['..', 'node_modules', '.vitepress'].includes(part));
      };
      const changed = (event, file) => {
        if (['add', 'change', 'unlink'].includes(event) && file.endsWith('.md') && (within(docs, file) || within(guide, file)) && process.connected) {
          process.send({ type: 'pagehaven:guide-changed' }, (error) => {
            if (error) disconnected();
          });
        }
      };
      // 父进程意外退出时，也不能留下占用端口的开发服务。
      const disconnected = () => { void server.close().finally(() => process.exit()); };
      server.watcher.add(guide);
      server.watcher.on('all', changed);
      process.once('disconnect', disconnected);
      dispose = () => {
        server.watcher.off('all', changed);
        process.off('disconnect', disconnected);
      };
    },
    closeServer() { dispose?.(); },
  };
}
