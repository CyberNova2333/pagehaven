import { swapHost } from './gallery.js';

/** 图片事件可能早于模块执行；挂载时同时检查已完成的缓存结果。 */
export function mountReaderImages(reader, { hosts = [] } = {}) {
  const cleanups = [];
  for (const page of reader.querySelectorAll('.page')) {
    const img = page.querySelector('.frame img');
    const feedback = page.querySelector('.image-feedback');
    const message = page.querySelector('.image-message');
    const retry = page.querySelector('.image-retry');
    if (!img || !feedback || !message || !retry) continue;

    const original = img.src;
    let sources = [original];
    try {
      const url = new URL(original);
      // 只对当前配置中的 HTTPS 图片源换域名，保留不可变图片的完整路径。
      if (url.protocol === 'https:' && hosts.includes(url.host)) {
        sources = [...new Set([url.host, ...hosts])].map((host) => swapHost(original, url.host, host));
      }
    } catch { /* 无效地址交给浏览器报错，仍提供本页重试。 */ }
    let attempt = 0;
    let state = '';
    let disposed = false;

    function render(next) {
      state = next;
      page.dataset.imageState = state;
      feedback.hidden = false;
      retry.hidden = state !== 'failed';
      message.textContent = state === 'failed'
        ? `第 ${page.dataset.n} 页图片加载失败，可重试；其他页仍可阅读。`
        : state === 'loaded' ? `第 ${page.dataset.n} 页 · 已加载` : `第 ${page.dataset.n} 页图片加载中…`;
    }
    function load() {
      if (!disposed && img.naturalWidth > 0) render('loaded');
    }
    function error() {
      if (disposed || state !== 'loading') return;
      if (attempt + 1 < sources.length) {
        attempt++;
        img.src = sources[attempt];
      } else render('failed');
    }
    function restart(event) {
      event.preventDefault();
      event.stopPropagation();
      if (disposed || state !== 'failed') return;
      attempt = 0;
      render('loading');
      // 手动重试只加载这一页，不重置章节、页码或阅读模式。
      img.loading = 'eager';
      img.src = sources[0];
    }

    img.addEventListener('load', load);
    img.addEventListener('error', error);
    retry.addEventListener('click', restart);
    render('loading');
    if (img.complete) {
      if (img.naturalWidth > 0) load();
      else error();
    }
    cleanups.push(() => {
      disposed = true;
      img.removeEventListener('load', load);
      img.removeEventListener('error', error);
      retry.removeEventListener('click', restart);
    });
  }
  return { destroy() { cleanups.forEach((cleanup) => cleanup()); } };
}
