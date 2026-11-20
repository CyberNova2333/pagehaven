export const STORAGE_KEY_USER_LANG = 'cbnv_user_lang';

function normalizeBase(base: string = '/'): string {
  const clean = '/' + String(base || '/').replace(/^[/\\]+/, '');
  return clean.endsWith('/') ? clean : clean + '/';
}

function getSafeWindowOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const origin = window.location?.origin;
  return origin && origin !== 'null' ? origin : null;
}

function isSameOriginUrl(url: string, origin: string, baseHref?: string): boolean {
  try {
    return new URL(url, baseHref || origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * 检测访客浏览器首选语言。
 * 若首选或支持列表中包含英文（en-XX），返回 'en'；
 * 若包含中文（zh-XX），返回 'zh'；
 * 无法识别（如法文、日文、德文等或其他未知语言）时，按需求严格默认为中文 'zh'。
 */
export function detectBrowserLanguage(): 'en' | 'zh' {
  if (typeof navigator === 'undefined') return 'zh';
  const langs =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || (navigator as any).userLanguage || ''];

  for (const lang of langs) {
    if (!lang || typeof lang !== 'string') continue;
    const lower = lang.trim().toLowerCase();
    if (lower.startsWith('en')) return 'en';
    if (lower.startsWith('zh')) return 'zh';
  }
  return 'zh'; // 无法识别时默认为中文
}

/**
 * 判断指定路径是否属于英文语言分区。
 */
export function isEnglishPath(path: string): boolean {
  if (!path) return false;
  return path === '/en' || path === '/en/' || path.startsWith('/en/');
}

/**
 * 将相对路径在中文路径与英文路径之间转换。
 */
export function getTargetRedirectUrl(
  targetLang: 'en' | 'zh',
  currentPath: string,
  base: string = '/'
): string | null {
  const normalizedBase = normalizeBase(base);

  let relPath = currentPath || '/';
  if (relPath.startsWith(normalizedBase)) {
    relPath = '/' + relPath.slice(normalizedBase.length);
  }
  relPath = '/' + relPath.replace(/^[/\\]+/, '');

  const isEn = isEnglishPath(relPath);
  let targetRelPath = relPath;

  if (targetLang === 'en' && !isEn) {
    if (relPath === '/' || relPath === '/index.html' || relPath === '') {
      targetRelPath = '/en/';
    } else {
      targetRelPath =
        '/en' + (relPath.startsWith('/') ? relPath : '/' + relPath);
    }
  } else if (targetLang === 'zh' && isEn) {
    if (
      relPath === '/en' ||
      relPath === '/en/' ||
      relPath === '/en/index.html'
    ) {
      targetRelPath = '/';
    } else {
      targetRelPath = relPath.replace(/^\/en(\/|$)/, '/');
      if (!targetRelPath) targetRelPath = '/';
    }
  } else {
    return null; // 无需重定向
  }

  targetRelPath = '/' + targetRelPath.replace(/^[/\\]+/, '');

  const basePrefix = normalizedBase.slice(0, -1);
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  const redirectUrl = basePrefix + targetRelPath + search + hash;
  const fallbackOrigin = getSafeWindowOrigin() ?? 'https://pagehaven.invalid';
  if (!isSameOriginUrl(redirectUrl, fallbackOrigin)) {
    return null;
  }
  return redirectUrl;
}

/**
 * 执行初次进入或带存储偏好的语言自动路由导流。
 */
export function checkAndApplyLanguageRedirect(base: string = '/'): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const saved = localStorage.getItem(STORAGE_KEY_USER_LANG);
    let targetLang: 'en' | 'zh';
    if (saved === 'en' || saved === 'zh') {
      targetLang = saved;
    } else {
      // 首次访问：根据浏览器语言自动选择，无法识别默认为中文
      targetLang = detectBrowserLanguage();
      localStorage.setItem(STORAGE_KEY_USER_LANG, targetLang);
    }

    const origin = getSafeWindowOrigin();
    if (!origin) return false;

    const currentPath = window.location.pathname;
    const redirectUrl = getTargetRedirectUrl(targetLang, currentPath, base);
    if (
      redirectUrl &&
      redirectUrl !== currentPath &&
      isSameOriginUrl(redirectUrl, origin, window.location.href || origin)
    ) {
      window.location.replace(redirectUrl);
      return true;
    }
  } catch {
    // 捕获 localStorage 限制或异常
  }
  return false;
}

let activeListenerCleanup: (() => void) | null = null;
let listenerBase = '/';

/**
 * 监听 VitePress 顶栏与移动端下拉菜单中的语言切换点击，持久化用户偏好。
 * 仅响应语言切换容器内的同源站内链接，避免普通导航或外链误改偏好。
 */
export function setupLanguageSwitcherListener(base: string = '/'): () => void {
  listenerBase = base;
  if (typeof document === 'undefined') return () => {};
  if (activeListenerCleanup) return activeListenerCleanup;

  let active = true;
  const onDocumentClick = (event: Event) => {
    if (!active) return;
    const target = event.target as {
      closest?: (selector: string) => Element | null;
    } | null;
    if (!target || typeof target.closest !== 'function') return;
    const link = target.closest('a');
    if (!link) return;

    const inTranslationMenu = !!link.closest(
      '.VPNavBarTranslations, .VPNavScreenTranslations'
    );
    if (!inTranslationMenu) return;

    const origin = getSafeWindowOrigin();
    if (!origin) return;

    const href = (link.getAttribute('href') || '').trim();
    if (!href || href.startsWith('#')) return;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(href, window.location.href || origin);
    } catch {
      return;
    }
    if (parsedUrl.origin !== origin) return;

    const normalizedBase = normalizeBase(listenerBase);
    let relPath = parsedUrl.pathname || '/';
    if (relPath.startsWith(normalizedBase)) {
      relPath = '/' + relPath.slice(normalizedBase.length);
    }
    relPath = '/' + relPath.replace(/^[/\\]+/, '');

    const hreflang = (
      link.getAttribute('hreflang') ||
      link.getAttribute('lang') ||
      ''
    ).toLowerCase();

    try {
      if (hreflang.startsWith('en') || isEnglishPath(relPath)) {
        localStorage.setItem(STORAGE_KEY_USER_LANG, 'en');
      } else if (hreflang.startsWith('zh') || !isEnglishPath(relPath)) {
        localStorage.setItem(STORAGE_KEY_USER_LANG, 'zh');
      }
    } catch {}
  };

  document.addEventListener('click', onDocumentClick, true); // capture 阶段触发，确保在路由跳转前写入

  const cleanup = () => {
    if (!active) return;
    active = false;
    document.removeEventListener('click', onDocumentClick, true);
    if (activeListenerCleanup === cleanup) {
      activeListenerCleanup = null;
    }
  };
  activeListenerCleanup = cleanup;
  return cleanup;
}

/**
 * 路由变化时，若用户发生了跨语言分区跳转，同步更新本地偏好。
 */
export function syncLanguageOnRoute(currentPath: string): void {
  if (typeof window === 'undefined') return;
  try {
    const isEn = isEnglishPath(currentPath);
    const expectedLang = isEn ? 'en' : 'zh';
    const saved = localStorage.getItem(STORAGE_KEY_USER_LANG);
    if (saved !== expectedLang) {
      localStorage.setItem(STORAGE_KEY_USER_LANG, expectedLang);
    }
  } catch {}
}
