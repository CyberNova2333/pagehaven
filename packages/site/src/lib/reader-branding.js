// 界面使用宿主站点标识，第三方版权与许可始终随静态产物保留。
export function readerBrandOptions(siteTitle, siteLogo = '/favicon.svg') {
  return {
    // area default 同时覆盖启动、菜单、加载与失败；单一 mascot 选项不会覆盖后两者。
    mascot: { default: { src: siteLogo, alt: siteTitle } },
    translations: {
      'settings.direction.rtl': '从右到左',
      'settings.direction.ltr': '从左到右',
      'menu.openAbout': '阅读器说明',
      'menu.openFavorites': '页码书签',
      'pageMode.spread': '双页',
      'favorites.description': '长按页面可添加书签，也可使用上方的收藏按钮。书签和备注可在“我的书架”中管理。',
      'favorites.empty': '还没有页码书签',
      'favorites.added': '已收藏本页',
      'favorites.addedUnsaved': '已收藏本页；未保存的修改仅在当前页面临时保留',
      'favorites.remove': '移除书签',
      'shortcut.pageModeToggle': '切换双页',
    },
  };
}

/**
 * 当前组件没有 about 内容替换选项；只适配其内容区，保留面板与返回按钮的原有行为。
 * 不改第三方包或版权，不把原组件版本号和外部产品链接当作本站信息展示。
 */
export function applyReaderBranding(root, siteTitle, siteLogo = '/favicon.svg') {
  const content = root.querySelector('.comimi-menu-view-about .comimi-about-inner');
  if (!content) return false;
  if (content.dataset.readerBranded !== 'true') {
    const doc = root.ownerDocument;
    const icon = doc.createElement('img');
    icon.src = siteLogo;
    icon.alt = '';
    icon.width = 64;
    icon.height = 64;
    const title = doc.createElement('h3');
    title.textContent = siteTitle;
    const text = doc.createElement('p');
    text.textContent = '增强分页支持缩放、手势和双页阅读。页码、书签与阅读进度与本站阅读器共用。';
    const license = doc.createElement('a');
    license.href = '/licenses/comimi.txt';
    license.target = '_blank';
    license.rel = 'noopener noreferrer';
    license.textContent = '第三方开源许可（MIT）';
    content.replaceChildren(icon, title, text, license);
    content.dataset.readerBranded = 'true';
    content.classList.add('reader-about');
  }
  root.querySelector('.comimi-arrow-prev')?.setAttribute('aria-label', '上一页');
  root.querySelector('.comimi-arrow-next')?.setAttribute('aria-label', '下一页');
  root.querySelector('.comimi-seek-input')?.setAttribute('aria-label', '页码进度');
  root.setAttribute('aria-label', `${siteTitle}漫画阅读器`);
  return true;
}
