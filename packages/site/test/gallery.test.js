// lib/gallery.js 的单测。这些纯函数拼出的是 18 000 份 HTML 里的图片 URL、站内 URL 与文字框坐标，
// 错一处就是全站错，而 .astro 不在 lint 与单测范围内——所以逻辑放进 .js、在这里钉死。
//
// swapHost 尤其要在这里测：阅读器真正跑的是内联脚本里的同一行（is:inline 没法 import），
// 流水线测试给不出「第二条域名真的接管」的浏览器场景，替换规则只能在这里钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boxStyle,
  chapterCount,
  chaptersByKey,
  imageUrl,
  isDot,
  jsonForScript,
  pct,
  swapHost,
  urlForKey,
} from '../src/lib/gallery.js';

test('imageUrl / urlForKey：URL 的拼法', () => {
  assert.equal(imageUrl('img.example.org', 'img/s/v/c/1-0123456789ab.avif'), 'https://img.example.org/img/s/v/c/1-0123456789ab.avif');
  assert.equal(urlForKey('s/v/c'), '/s/v/c/');
});

test('pct：0–1 → 百分比，最多 4 位小数、不留无意义的零', () => {
  assert.equal(pct(0), '0%');
  assert.equal(pct(1), '100%');
  assert.equal(pct(0.12), '12%');
  assert.equal(pct(0.5), '50%');
  assert.equal(pct(1 / 3), '33.3333%');
  assert.equal(pct(0.123456789), '12.3457%');
});

test('boxStyle / isDot：普通框给四个值，点标签（w=h=0）只给 left/top', () => {
  const box = { x: 0.12, y: 0.08, w: 0.2, h: 0.15 };
  assert.equal(isDot(box), false);
  assert.equal(boxStyle(box), 'left:12%;top:8%;width:20%;height:15%');
  const dot = { x: 0.5, y: 0.25, w: 0, h: 0 };
  assert.equal(isDot(dot), true);
  assert.equal(boxStyle(dot), 'left:50%;top:25%');
  // 只有一边为 0 不算点：宽 0 高非 0 的框仍按框画
  assert.equal(isDot({ x: 0, y: 0, w: 0, h: 0.1 }), false);
});

test('jsonForScript：内联 JSON 里不会出现 </script，且解析回来与原值相同', () => {
  const value = { q: '</script><script>alert(1)</script>', hosts: ['a.example', 'b.example'], n: 1 };
  const out = jsonForScript(value);
  assert.ok(!out.includes('<'), '输出里不该有字面量 <');
  assert.ok(out.includes('\\u003c/script'), '< 应写成 JSON 转义 \\u003c');
  assert.deepEqual(JSON.parse(out), value);
});

test('chaptersByKey / chapterCount', () => {
  const gallery = {
    series: [
      {
        issues: [
          { chapters: [{ key: 's/v1/c1', title: '一' }, { key: 's/v1/c2', title: '二' }] },
          { chapters: [{ key: 's/v2/c3', title: '三' }] },
        ],
      },
      { issues: [{ chapters: [{ key: 'z/v/c', title: 'Z' }] }] },
    ],
  };
  const byKey = chaptersByKey(gallery);
  assert.equal(byKey.size, 4);
  assert.equal(byKey.get('s/v2/c3').title, '三');
  assert.equal(byKey.get('nope'), undefined);
  assert.equal(chapterCount(gallery.series[0]), 3);
  assert.equal(chapterCount(gallery.series[1]), 1);
  assert.equal(chapterCount({ issues: [] }), 0);
});

test('swapHost：只换掉 URL 里作为域名出现的那一处', () => {
  const from = 'img.example.org';
  const to = 'img2.example.org';
  assert.equal(swapHost('https://img.example.org/img/s/v/c/1-0123456789ab.webp', from, to), 'https://img2.example.org/img/s/v/c/1-0123456789ab.webp');
  // <source srcset> 也是一条裸 URL，同样处理
  assert.equal(swapHost('https://img.example.org/img/s/v/c/1-0123456789ab.avif', from, to), 'https://img2.example.org/img/s/v/c/1-0123456789ab.avif');
  // 路径里恰好含有域名字样：只换域名那一处
  assert.equal(swapHost('https://img.example.org/img.example.org/x.webp', from, to), 'https://img2.example.org/img.example.org/x.webp');
  // 域名只是另一个域名的后缀：不动
  assert.equal(swapHost('https://cdn-img.example.org/x.webp', from, to), 'https://cdn-img.example.org/x.webp');
  // 根本不是第一条域名的图（已经切过、或别处来的）：原样返回
  assert.equal(swapHost('https://img2.example.org/x.webp', from, to), 'https://img2.example.org/x.webp');
  assert.equal(swapHost('https://other.example/x.webp', from, to), 'https://other.example/x.webp');
});
