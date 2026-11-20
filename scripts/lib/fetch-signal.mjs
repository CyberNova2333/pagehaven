// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// HTTP 请求的中止信号组合工具：为外部调用默认附加超时上限，并保留调用方的 AbortSignal。

/**
 * 将可选的调用方 `signal` 与超时 `timeoutMs` 合成为单一 `AbortSignal`。
 * @param {AbortSignal} [signal]
 * @param {number} [timeoutMs]
 * @returns {AbortSignal | undefined}
 */
export function combineFetchSignal(signal, timeoutMs) {
  const signals = [];
  if (signal) signals.push(signal);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}
