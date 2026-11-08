import { animate, createScope, stagger, utils } from "animejs";

// 只增强目录和标题；漫画坐标、文字层和分页插件不参与动画。
export function mountPageMotion() {
  let motion;
  const reveal = () => {
    motion?.revert();
    motion = createScope({
      mediaQueries: { reduced: "(prefers-reduced-motion: reduce)" },
    }).add((self) => {
      if (!self || self.matches["reduced"]) return;
      const targets = Array.from(
        document.querySelectorAll(
          "main > h1, main > p.eyebrow, .hero-body, .series-grid > li",
        ),
      ).slice(0, 16);
      if (targets.length) {
        for (const el of targets) {
          el.style.opacity = "0";
          el.style.transform = "translateY(10px)";
        }
        animate(targets, {
          opacity: [0, 1],
          y: [10, 0],
          duration: 700,
          delay: stagger(70),
          ease: "outCubic",
          onComplete: utils.cleanInlineStyles,
        });
      }
    });
  };
  reveal();
  window.addEventListener("pagehide", () => motion?.revert());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) reveal();
  });
}
