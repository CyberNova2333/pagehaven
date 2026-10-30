import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const hasControls = (value) => [...value].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127);

/** URL 路由只映射到输出根下的目录，不能让路径归一化改变目标或跨平台含义。 */
export function redirectOutputPaths(distDir, route) {
  const fail = () => { throw new Error('重定向来源必须是输出目录内的规范站内路径'); };
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\?#\s]/u.test(route) || hasControls(route)) fail();
  const path = route === '/' ? '' : route.slice(1).replace(/\/$/, '');
  const segments = path ? path.split('/') : [];
  const decoded = segments.map((segment) => {
    let value;
    try { value = decodeURIComponent(segment); } catch { fail(); }
    if (!value || value === '.' || value === '..' || /[\\/:%?#\s]/u.test(value) || hasControls(value)) fail();
    return value;
  });
  const root = resolve(distDir);
  const dir = resolve(root, ...decoded);
  const file = join(dir, 'index.html');
  const inside = relative(root, file);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) fail();
  return { dir, file };
}

export function metaRefresh(to, lang) {
  const esc = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${esc(to)}"><link rel="canonical" href="${esc(to)}"><title>跳转中</title></head><body><a href="${esc(to)}">${esc(to)}</a></body></html>\n`;
}
