import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkReadmeLinks } from '../lib/readme-links.mjs';

test('README 章节链接接受中文、含空格英文标题的实际锚点及 URL 编码', () => {
  const markdown = [
    '<a href="#主要功能">功能</a>',
    '<a href="#getting-started">开始</a>',
    '[功能](#%E4%B8%BB%E8%A6%81%E5%8A%9F%E8%83%BD)',
    '[开始](#getting%2Dstarted "阅读指引")',
    '[开始](<#getting-started>)',
    '## 主要功能',
    '## Getting started ##',
  ].join('\n');
  assert.deepEqual(checkReadmeLinks(markdown, 'README.md'), []);
});

test('README 章节链接拒绝英文原文及过时别名，并指出文件及错误 fragment', () => {
  const problems = checkReadmeLinks([
    '## Features',
    '## Getting started',
    '<a href="#Features">Features</a>',
    '[开始](#Getting%20started)',
    '<a href="#Getting started">开始</a>',
    '<a href="#section-1">架构</a>',
    '[边界](#limitations)',
    '<a id="section-1"></a>',
    '<a id="limitations"></a>',
  ].join('\n'), 'README.en.md');
  assert.equal(problems.length, 5);
  assert.ok(problems.some((problem) => problem.includes('README.en.md:3') && problem.includes('#Features')));
  assert.ok(problems.some((problem) => problem.includes('README.en.md:4') && problem.includes('#Getting%20started')));
  assert.ok(problems.some((problem) => problem.includes('README.en.md:5') && problem.includes('#Getting started')));
  assert.ok(problems.some((problem) => problem.includes('#section-1')));
  assert.ok(problems.some((problem) => problem.includes('#limitations')));
});

test('README 标题锚点去掉标点并保留中文及已有连字符', () => {
  const markdown = '## 配置：界面（可选）!\n[配置](#配置界面可选)\n## Read-only!\n[工具](#read-only)';
  assert.deepEqual(checkReadmeLinks(markdown, 'README.md'), []);
});

test('README 标题删除或改名后，原链接失效，其他链接仍可检查', () => {
  const problems = checkReadmeLinks('## 新标题\n[旧标题](#旧标题)\n[新标题](#新标题)', 'README.md');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /README\.md:2.*#旧标题/);
});

test('README 检查忽略反引号和波浪线围栏中的假标题及链接', () => {
  const markdown = [
    '## 实际标题',
    '````md',
    '## 假标题',
    '<a href="#不存在">示例</a>',
    '```',
    '[示例](#仍在代码块中)',
    '````',
    '   ~~~markdown',
    '[示例](#不存在)',
    '   ~~~~',
    '[正文](#实际标题)',
    '[假标题](#假标题)',
  ].join('\n');
  const problems = checkReadmeLinks(markdown, 'README.md');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /README\.md:12.*#假标题/);
});

test('README 章节链接报告坏 URL 编码，不使整个守卫中止', () => {
  const problems = checkReadmeLinks('## Features\n[坏编码](#%ZZ)\n[失效链接](#missing)', 'README.en.md');
  assert.equal(problems.length, 2);
  assert.match(problems[0], /README\.en\.md:2.*#%ZZ.*URL 编码无效/);
  assert.match(problems[1], /README\.en\.md:3.*#missing/);
});

test('仓库的两份 README 章节链接与当前标题保持一致', async () => {
  for (const file of ['README.md', 'README.en.md']) {
    const markdown = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(checkReadmeLinks(markdown, file), [], file);
  }
});
