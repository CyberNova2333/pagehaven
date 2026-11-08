import { animate, createScope, utils } from 'animejs';

// 只增强目录和标题；漫画坐标、文字层和分页插件不参与动画。
export function mountPageMotion() {
  let motion;
  const reveal = () => {
    motion?.revert();
    motion = createScope({ mediaQueries: { reduced: '(prefers-reduced-motion: reduce)' } }).add((self) => {
      if (!self || self.matches['reduced']) return;
      const targets = document.querySelectorAll('main > h1, main > p.eyebrow, .hero-body, .series-grid > li');
      if (targets.length) animate(Array.from(targets).slice(0, 16), { opacity: [0, 1], duration: 160, ease: 'easeOut', onComplete: utils.cleanInlineStyles });
    });
  };
  reveal();
  window.addEventListener('pagehide', () => motion?.revert());
  window.addEventListener('pageshow', (event) => { if (event.persisted) reveal(); });
}
