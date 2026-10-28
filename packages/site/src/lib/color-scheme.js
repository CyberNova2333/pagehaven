/**
 * 自包含以便构建为 head 中的同步脚本，在正文出现前恢复个人配色。
 * 不捕获模块变量；同一实现负责首屏、控件与系统变化，避免两套偏好规则漂移。
 */
export function initializeColorScheme(win, doc) {
  const key = 'pagehaven:color-scheme';
  const root = doc.documentElement;
  const normalize = (value) => value === 'light' || value === 'dark' ? value : 'system';
  let preference = 'system';
  let limited = false;
  let pending = false;
  let media;
  let select;
  let control;
  let status;
  try { media = win.matchMedia('(prefers-color-scheme: dark)'); } catch { /* 旧环境按浅色处理。 */ }

  function read() {
    try { preference = normalize(win.localStorage.getItem(key)); limited = false; }
    catch { limited = true; }
  }
  function apply() {
    const previous = root.dataset.resolvedColorScheme;
    const scheme = preference === 'system' ? media?.matches ? 'dark' : 'light' : preference;
    root.dataset.colorScheme = preference;
    root.dataset.resolvedColorScheme = scheme;
    const metas = doc.querySelectorAll('[data-color-scheme-meta]');
    for (const meta of metas) {
      const color = meta.dataset.colorSchemeMeta;
      meta.setAttribute('media', preference === 'system' ? `(prefers-color-scheme: ${color})` : color === scheme ? 'all' : 'not all');
    }
    if (select) select.value = preference;
    if (status) {
      status.hidden = !limited;
      status.textContent = limited ? '浏览器未允许保存配色，本页选择仍然有效，重新打开后可能需要再选一次。' : '';
    }
    if (scheme !== previous) {
      win.dispatchEvent(new win.CustomEvent('pagehaven:color-scheme-change', { detail: { scheme, preference } }));
    }
  }
  function change() {
    preference = normalize(select.value);
    try { win.localStorage.setItem(key, preference); pending = limited = false; }
    catch { pending = limited = true; }
    apply();
  }
  function bind() {
    control = doc.querySelector('[data-color-scheme-control]');
    select = doc.getElementById('color-scheme-select');
    status = doc.getElementById('color-scheme-status');
    select?.addEventListener('change', change);
    if (control && select) control.hidden = false;
    apply();
  }
  const onSystem = () => { if (preference === 'system') apply(); };
  const sync = () => { if (!pending) read(); apply(); };
  const onStorage = (event) => {
    if (event.key !== null && event.key !== key) return;
    // 本窗口尚未保存的选择继续生效，直到读者明确重试保存或重新载入。
    sync();
  };
  read();
  apply();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  if (media?.addEventListener) media.addEventListener('change', onSystem);
  else media?.addListener?.(onSystem);
  win.addEventListener('storage', onStorage);
  win.addEventListener('pageshow', sync);
  win.addEventListener('focus', sync);
  return {
    get preference() { return preference; },
    get scheme() { return root.dataset.resolvedColorScheme; },
    destroy() {
      select?.removeEventListener('change', change);
      doc.removeEventListener('DOMContentLoaded', bind);
      if (media?.removeEventListener) media.removeEventListener('change', onSystem);
      else media?.removeListener?.(onSystem);
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('pageshow', sync);
      win.removeEventListener('focus', sync);
    },
  };
}
