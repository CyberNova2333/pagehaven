// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 日志与报错的敏感信息脱敏工具（纯函数）：抹去凭据、令牌、签名串、桶名与 HTTP(S) URL。

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 从字符串中脱敏常见凭据模式及给定的敏感字面量（账号、桶名、密钥、端点主机名等）。
 * `exactLiterals`（如桶名、端点主机名）直接整段替换；`literals` 中较短的占位串（< 4 字符，
 * 如测试里的 `ak` / `sk` / `t`）按分隔边界匹配，避免误伤正常英文错误文本或栈帧（如 `stack`）。
 *
 * @param {unknown} input
 * @param {{
 *   literals?: Array<string|undefined|null>,
 *   exactLiterals?: Array<string|undefined|null>,
 *   minLiteralLength?: number,
 *   redactUrls?: boolean,
 *   replacement?: string,
 * }} [opts]
 * @returns {string}
 */
export function redactText(
  input,
  { literals = [], exactLiterals = [], minLiteralLength = 4, redactUrls = true, replacement = '…' } = {},
) {
  let text = String(input ?? '');
  if (!text) return text;

  if (redactUrls) {
    text = text.replace(/https?:\/\/[^\s"'`<>()）]+/gi, replacement);
  } else {
    text = text.replace(/(https?:\/\/)[^/\s:@]+:[^@\s]+@/gi, `$1${replacement}@`);
  }

  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${replacement}`)
    .replace(/\bAWS4-HMAC-SHA256\b[^\r\n]*/g, `AWS4-HMAC-SHA256 ${replacement}`)
    .replace(/\bCredential=[^,\s]+/gi, `Credential=${replacement}`)
    .replace(/\bSignature=[0-9a-f]{16,}/gi, `Signature=${replacement}`)
    .replace(/([?&](?:X-Amz-[^=]+|token|secret|key|password|auth)=)[^&\s"'`]+/gi, `$1${replacement}`)
    .replace(/\b(Authorization|x-amz-security-token|Cookie|Set-Cookie)\s*[:=]\s*[^\r\n,;]+/gi, `$1: ${replacement}`);

  const uniqueExact = [...new Set(exactLiterals.filter((s) => typeof s === 'string' && s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of uniqueExact) {
    text = text.split(secret).join(replacement);
  }

  const unique = [...new Set(literals.filter((s) => typeof s === 'string' && s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of unique) {
    if (secret.length >= minLiteralLength) {
      text = text.split(secret).join(replacement);
    } else {
      const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(secret)}(?![A-Za-z0-9_-])`, 'g');
      text = text.replace(pattern, replacement);
    }
  }
  return text;
}

/**
 * 从环境变量提取对象存储相关的敏感字面量（密钥、账号、桶名、直连端点及其主机名）。
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ literals: string[], exactLiterals: string[] }}
 */
export function r2EnvSecrets(env = process.env) {
  const literals = [];
  const exactLiterals = [];
  for (const key of ['R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID']) {
    if (env[key]) literals.push(env[key]);
  }
  for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ENDPOINT']) {
    if (env[key]) exactLiterals.push(env[key]);
  }
  if (env.R2_ACCOUNT_ID) {
    exactLiterals.push(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    exactLiterals.push(`${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  }
  if (env.R2_ENDPOINT) {
    try {
      const parsed = new URL(env.R2_ENDPOINT);
      if (parsed.origin && parsed.origin !== 'null') exactLiterals.push(parsed.origin);
      if (parsed.host) exactLiterals.push(parsed.host);
      if (parsed.hostname) exactLiterals.push(parsed.hostname);
    } catch {
      /* 非法 URL 原值已在上面加入 */
    }
  }
  return { literals, exactLiterals };
}
