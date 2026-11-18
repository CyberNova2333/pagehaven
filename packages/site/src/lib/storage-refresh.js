// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and ADDITIONAL_TERMS.zh-CN.md; ref: ADDITIONAL_TERMS.en.md).
/**
 * 合并短时间内的存储更新；窗口从首次请求开始，后续事件不会推迟刷新。
 * 显式读取前可 cancel，销毁后即使旧回调迟到也不会再次更新界面。
 */
export function createStorageRefresh(win, refresh, { delayMs = 50 } = {}) {
  if (typeof refresh !== 'function') throw new TypeError('刷新回调无效');
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2147483647) throw new TypeError('刷新等待时间无效');
  let timer = null;
  let generation = 0;
  let destroyed = false;

  function cancel() {
    generation += 1;
    if (timer !== null) {
      win.clearTimeout(timer);
      timer = null;
    }
  }

  return {
    request() {
      if (destroyed || timer !== null) return;
      const ticket = ++generation;
      timer = win.setTimeout(() => {
        if (destroyed || ticket !== generation) return;
        timer = null;
        refresh();
      }, delayMs);
    },
    cancel,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
    },
  };
}
