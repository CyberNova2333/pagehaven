// 昼夜场景只展示已经解析的配色；三态选择、持久化和跨窗口同步仍由 color-scheme 负责。
export function mountDayNightControl(win, doc) {
  let view;
  let slot;
  const isDark = () => doc.documentElement.dataset.resolvedColorScheme === 'dark';
  const sync = () => view?.apply(isDark());
  function init() {
    const select = doc.getElementById('color-scheme-select');
    const control = doc.querySelector('[data-color-scheme-control]');
    if (view || !select || !control || !win.DayNightSwitch) return;
    slot = doc.createElement('span');
    slot.className = 'day-night-control';
    slot.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle';
    // 三态入口一直可见；场景开关只是相邻的快捷操作，不取代“跟随系统”。
    control.parentNode.insertBefore(slot, control);
    view = win.DayNightSwitch.mount(slot, {
      isDark,
      onToggle(next) {
        select.value = next ? 'dark' : 'light';
        select.dispatchEvent(new win.Event('change'));
      },
    });
    win.addEventListener('pagehaven:color-scheme-change', sync);
    sync();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  return {
    destroy() {
      doc.removeEventListener('DOMContentLoaded', init);
      win.removeEventListener('pagehaven:color-scheme-change', sync);
      view?.destroy();
      slot?.remove();
    },
  };
}
