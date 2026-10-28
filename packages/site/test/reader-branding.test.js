import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReaderBranding, readerBrandOptions } from '../src/lib/reader-branding.js';

function fixture({ about = true, arrows = true } = {}) {
  const doc = { createElement: (tag) => element(tag) };
  function element(tag, className = '') {
    const classes = new Set(className.split(' ').filter(Boolean));
    const attributes = new Map();
    const node = {
      tagName: tag.toUpperCase(), ownerDocument: doc, dataset: {}, children: [], textContent: '',
      classList: { add: (name) => classes.add(name), contains: (name) => classes.has(name) },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: (name) => attributes.get(name) ?? null,
      replaceChildren(...children) { this.children = children; },
      querySelector(selector) {
        let roots = [this];
        for (const name of selector.split(' ')) {
          roots = roots.flatMap((root) => descendants(root).filter((child) => name.startsWith('.')
            ? child.classList.contains(name.slice(1)) : child.tagName === name.toUpperCase()));
        }
        return roots[0] ?? null;
      },
    };
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('品牌文案不能通过 HTML 注入'); } });
    return node;
  }
  const root = element('div');
  const view = element('section', 'comimi-menu-view-about');
  const back = element('button', 'comimi-menu-back');
  back.textContent = '返回';
  const content = element('div', 'comimi-about-inner');
  const oldLogo = element('img');
  oldLogo.src = '/upstream-logo.svg';
  const oldLink = element('a');
  oldLink.textContent = '关于上游产品';
  content.replaceChildren(oldLogo, oldLink);
  view.replaceChildren(back, ...(about ? [content] : []));
  const prev = element('button', 'comimi-arrow-prev');
  const next = element('button', 'comimi-arrow-next');
  const seek = element('input', 'comimi-seek-input');
  prev.setAttribute('aria-label', 'Previous page');
  next.setAttribute('aria-label', 'Next page');
  root.replaceChildren(view, seek, ...(arrows ? [prev, next] : []));
  return { root, view, back, content, oldLogo, oldLink, prev, next, seek };
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

test('阅读器标识：官方默认区域统一使用站点图标，并覆盖产品说明与收藏用语', () => {
  const options = readerBrandOptions('书页小屋');
  assert.deepEqual(options.mascot, { default: { src: '/favicon.svg', alt: '书页小屋' } }, 'default 区域同时覆盖启动、菜单、加载与错误图标');
  assert.equal(options.translations['menu.openAbout'], '阅读器说明');
  assert.equal(options.translations['menu.openFavorites'], '页码书签');
  for (const key of ['favorites.description', 'favorites.empty', 'favorites.added', 'favorites.addedUnsaved', 'favorites.remove']) {
    assert.equal(typeof options.translations[key], 'string', `${key} 不应回退到上游文案`);
    assert.doesNotMatch(options.translations[key], /超喜欢|comimi/i);
  }
  assert.match(options.translations['favorites.description'], /我的书架/);
  assert.match(options.translations['favorites.addedUnsaved'], /当前页面/);
});

test('阅读器标识：替换说明内容与翻页标签，保留面板和返回按钮', () => {
  const f = fixture();
  assert.equal(applyReaderBranding(f.root, '书页小屋'), true);
  assert.deepEqual(f.view.children, [f.back, f.content]);
  assert.equal(f.back.textContent, '返回');
  assert.equal(descendants(f.root).includes(f.oldLogo), false);
  assert.equal(descendants(f.root).includes(f.oldLink), false);
  const image = f.content.querySelector('img');
  assert.equal(image.src, '/favicon.svg');
  assert.equal(image.alt, '', '说明区图标旁已有站名，无需重复朗读');
  assert.equal(f.content.querySelector('h3').textContent, '书页小屋');
  assert.match(f.content.querySelector('p').textContent, /缩放|手势|双页/);
  assert.equal(f.prev.getAttribute('aria-label'), '上一页');
  assert.equal(f.next.getAttribute('aria-label'), '下一页');
  assert.equal(f.seek.getAttribute('aria-label'), '页码进度');
  assert.equal(f.root.getAttribute('aria-label'), '书页小屋漫画阅读器');
  const license = f.content.querySelector('a');
  assert.equal(license.href, '/licenses/comimi.txt');
  assert.match(license.textContent, /第三方.*MIT/);
  assert.equal(license.target, '_blank');
  assert.match(license.rel, /noopener/);
  assert.match(license.rel, /noreferrer/);
});

test('阅读器标识：站名按纯文本呈现，重复调用不会增加说明节点', () => {
  const f = fixture();
  const title = '书页 <img src=x onerror="alert(1)"> & 小屋';
  assert.equal(applyReaderBranding(f.root, title), true);
  assert.equal(f.content.querySelector('h3').textContent, title);
  assert.equal(descendants(f.content).filter((node) => node.tagName === 'IMG').length, 1);
  const original = [...f.content.children];
  assert.equal(applyReaderBranding(f.root, title), true);
  assert.deepEqual(f.content.children, original);
});

test('阅读器标识：上游说明结构变化时返回失败，保留现有节点供适配层回退', () => {
  const f = fixture({ about: false });
  const original = [...f.view.children];
  assert.equal(applyReaderBranding(f.root, '书页小屋'), false);
  assert.deepEqual(f.view.children, original);
  assert.equal(f.prev.getAttribute('aria-label'), 'Previous page');
  assert.equal(f.next.getAttribute('aria-label'), 'Next page');
});

test('阅读器标识：窄屏未生成翻页按钮时仍可替换说明', () => {
  const f = fixture({ arrows: false });
  assert.equal(applyReaderBranding(f.root, '书页小屋'), true);
  assert.equal(f.content.querySelector('h3').textContent, '书页小屋');
});

test('阅读器标识：宿主自定义图标同时用于默认区域和说明面板', () => {
  const f = fixture();
  const logo = 'https://images.example.org/site-logo.svg';
  assert.equal(readerBrandOptions('书页小屋', logo).mascot.default.src, logo);
  assert.equal(applyReaderBranding(f.root, '书页小屋', logo), true);
  assert.equal(f.content.querySelector('img').src, logo);
});
