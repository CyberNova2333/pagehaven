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
          el.style.transform = "translateY(12px)";
        }
        animate(targets, {
          opacity: [0, 1],
          y: [12, 0],
          duration: 1100,
          delay: stagger(90),
          ease: "out(2)",
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
