// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import { mountSearch as mount } from './mount.js';

export function mountSearch() {
  const workerFactory = typeof Worker === 'function'
    ? () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    : undefined;
  return mount({ workerFactory });
}
