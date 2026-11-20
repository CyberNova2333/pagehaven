// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// GitHub 的 README 章节链接：标题锚点去重，自定义锚点独立于标题编号。
// 只检查本页的 HTML href 和 Markdown 内联链接，不把示例代码当成正文。
export function checkReadmeLinks(markdown, file) {
  let fence = null;
  const lines = markdown.split(/\r?\n/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      return '';
    }
    return line;
  });
  const headings = new Set();
  for (const line of lines) {
    const heading = /^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/.exec(line);
    if (heading) {
      const base = heading[1].replace(/[ \t]+#+[ \t]*$/, '').trim()
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
        .replace(/(^|\s)_{1,2}([^_]+)_{1,2}(?=$|\s|[.,!?])/g, '$1$2')
        .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replace(/ /g, '-');
      let anchor = base;
      let suffix = 0;
      while (headings.has(anchor)) anchor = `${base}-${++suffix}`;
      headings.add(anchor);
    }
  }

  const text = lines.join('\n');
  const anchors = new Set(headings);
  for (const match of text.matchAll(/<a\b[^>]*\s(?:name|id)\s*=\s*(["'])([^"']+)\1[^>]*>/gi)) {
    anchors.add(match[2]);
  }
  const problems = [];
  const patterns = [
    /\bhref\s*=\s*(["'])#([^"']*)\1/gi,
    /\]\(\s*(?:<#([^>\r\n]*)>|#([^\s)\r\n]*))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?\s*\)/g,
  ];
  for (const [index, pattern] of patterns.entries()) {
    for (const match of text.matchAll(pattern)) {
      const fragment = index === 0 ? match[2] : (match[1] ?? match[2]);
      const location = `${file}:${text.slice(0, match.index).split('\n').length}`;
      let decoded;
      try {
        decoded = decodeURIComponent(fragment);
      } catch {
        problems.push(`${location} 章节链接 #${fragment} 的 URL 编码无效`);
        continue;
      }
      if (!anchors.has(decoded)) {
        problems.push(`${location} 章节链接 #${fragment} 未匹配 GitHub 标题或自定义锚点（标题小写、空格转连字符、重复标题带编号）`);
      }
    }
  }
  return problems;
}
