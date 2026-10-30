// CNB 的 README 章节参数与标题生成的锚点一致：小写、空白转连字符、去除标点。
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
      headings.add(heading[1].replace(/[ \t]+#+[ \t]*$/, '').trim().toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/\s/g, '-'));
    }
  }

  const text = lines.join('\n');
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
      if (!headings.has(decoded)) {
        problems.push(`${location} 章节链接 #${fragment} 未匹配实际标题生成的 CNB 锚点（小写、空白转连字符、去除标点）`);
      }
    }
  }
  return problems;
}
