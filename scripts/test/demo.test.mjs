// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startDemo } from '../demo.mjs';

test('本地样本站：手机视口从台词跳到气泡，翻页后由首页续读', { timeout: 120_000 }, async (t) => {
  const demo = await startDemo({ port: 0 });
  t.after(demo.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const origin = 'http://127.0.0.1:' + demo.port;
  const external = [];
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(origin + '/search/');
  await page.getByRole('link', { name: '找作品' }).click();
  await page.locator('#meta-q').fill('不存在的作品');
  await page.getByText('没有匹配的作品', { exact: true }).waitFor();
  await page.locator('#meta-q').fill('归航灯');
  await page.locator('#meta-results a[href="/beacon/"]').waitFor();
  assert.equal(await page.locator('#meta-results a').innerText(), '潮汐手记');
  await page.getByRole('link', { name: '搜台词', exact: true }).click();
  await page.locator('#search-input').fill('灯塔');
  const fetched = page.waitForResponse((r) => r.url().endsWith('.sqlite'));
  await page.locator('#search-form button').click();
  const db = await fetched;
  assert.equal(db.status(), 200);
  assert.equal((await db.body()).subarray(0, 16).toString(), 'SQLite format 3\0');
  await page.locator('#search-results a').first().click();
  const chapter = '/beacon/v1/signal/';
  assert.equal(new URL(page.url()).hash, '#p1b0');
  await page.locator('#p1b0.hl').waitFor();
  assert.equal(await page.locator('#p1b0').innerText(), '今晚，灯塔会亮吗？');
  await page.locator('#p1[data-image-state="loaded"]').waitFor();
  await page.locator('#page-next').click();
  await page.locator('#p2[data-image-state="loaded"]').waitFor();
  assert.equal(await page.locator('#p2 img').evaluate((img) => img.naturalWidth), 800);
  await page.locator('a[href="/"]').first().click();
  const resume = page.locator('#continue-list a');
  await resume.waitFor();
  assert.equal(await resume.getAttribute('href'), chapter + '#p2');
  await resume.click();
  await page.waitForFunction(() => globalThis.document.querySelector('#reader')?.galleryReader?.getState().page === 2);
  assert.deepEqual(external, []);
  assert.deepEqual(failures, []);
});

test('大书库手机搜索：首屏可搜台词，按需找作品，两处结果可用浏览器前进后退恢复', { timeout: 120_000 }, async (t) => {
  const demo = await startDemo({ port: 0 });
  t.after(demo.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const origin = 'http://127.0.0.1:' + demo.port;
  const catalog = Array.from({ length: 200 }, (_, i) => ({ title: '作品 ' + (i + 1), url: '/test-' + (i + 1) + '/', chapters: 1 }));
  const requests = { catalog: 0, db: 0 };
  page.on('request', (req) => { if (req.url().endsWith('.sqlite')) requests.db++; });
  await page.route('**/index/series.json', (route) => {
    requests.catalog++;
    return route.fulfill({ json: catalog });
  });
  await page.goto(origin);
  await page.getByRole('link', { name: '搜索台词' }).first().click();
  const modes = page.getByRole('navigation', { name: '搜索类型' });
  await modes.waitFor();
  const input = page.getByRole('searchbox', { name: '台词片段' });
  const rect = await input.boundingBox();
  assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= 844, '台词输入框应在手机首屏内');
  assert.deepEqual(requests, { catalog: 0, db: 0 });

  const titles = modes.getByRole('link', { name: '找作品' });
  const lines = modes.getByRole('link', { name: '搜台词' });
  await titles.focus();
  await page.keyboard.press('Enter');
  await page.locator('#meta-results a').nth(49).waitFor();
  assert.equal(await titles.getAttribute('aria-current'), 'true');
  assert.equal(await page.locator('#meta-results a').count(), 50);
  const more = page.getByRole('button', { name: '加载更多作品' });
  await more.focus();
  await page.keyboard.press('Enter');
  await page.locator('#meta-results a').nth(99).waitFor();
  assert.equal(await page.locator(':focus').textContent(), '作品 51');
  await page.locator('#meta-q').fill('作品 200');
  await page.locator('#meta-results a[href="/test-200/"]').waitFor();
  assert.deepEqual(requests, { catalog: 1, db: 0 });

  await page.goBack();
  await input.waitFor();
  await page.goForward();
  await page.locator('#meta-results a[href="/test-200/"]').waitFor();
  assert.equal(await page.locator('#meta-q').inputValue(), '作品 200');
  assert.deepEqual(requests, { catalog: 1, db: 0 });

  await page.goto(origin + '/search/?q=灯塔&series=beacon#titles');
  await page.locator('#meta-results a').first().waitFor();
  assert.equal(requests.db, 0, '作品直达链接不执行隐藏的台词查询');
  await lines.click();
  const hit = page.locator('#search-results a').first();
  await hit.waitFor();
  assert.equal(await hit.textContent(), '今晚，灯塔会亮吗？');
  assert.equal(await page.locator('#search-series').inputValue(), 'beacon');
  await titles.click();
  await lines.click();
  await input.fill('回港');
  await page.locator('#search-form button').click();
  await page.getByRole('link', { name: '看，回港的信号！' }).waitFor();
  await page.goBack();
  await page.locator('#meta-q').waitFor();
  await page.goBack();
  await page.getByRole('link', { name: '今晚，灯塔会亮吗？' }).waitFor();
  assert.equal(await input.inputValue(), '灯塔');
  assert.equal(requests.db, 1);
});

test('手机横屏读高图：从页中点到下一页能看见开头，开头已可见时保持位置', { timeout: 120_000 }, async (t) => {
  const demo = await startDemo({ port: 0 });
  t.after(demo.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
  });
  await page.goto('http://127.0.0.1:' + demo.port + '/beacon/v1/signal/');
  await page.locator('#p1[data-image-state="loaded"]').waitFor();
  const frame = page.locator('.page.current .frame');
  // 将已显示的画面移到固定位置，再走真实触屏或键盘入口。
  const placeTop = (top) => frame.evaluate((node, y) => {
    globalThis.scrollBy(0, node.getBoundingClientRect().top - y);
  }, top);
  const headerBottom = await page.locator('.topbar').evaluate((bar) => bar.getBoundingClientRect().bottom);
  assert.ok((await frame.boundingBox()).height > 900);

  await placeTop(-500);
  await page.touchscreen.tap(700, 180);
  await page.locator('#p2.current[data-image-state="loaded"]').waitFor();
  assert.equal(new URL(page.url()).hash, '#p2');
  const opening = await frame.boundingBox();
  assert.ok(opening.y >= headerBottom && opening.y < 390, '新画面开头应在吸顶栏下面且位于首屏');

  await placeTop(-300);
  const atEnd = await page.evaluate(() => globalThis.scrollY);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => globalThis.scrollY), atEnd, '已到末页时不跳回顶部');
  await page.keyboard.press('ArrowLeft');
  await page.locator('#p1.current').waitFor();
  assert.ok((await frame.boundingBox()).y >= headerBottom, '往回翻也能看到上一页的开头');

  await placeTop(headerBottom + 24);
  const before = await page.evaluate(() => globalThis.scrollY);
  await page.keyboard.press('ArrowRight');
  await page.locator('#p2.current').waitFor();
  assert.equal(await page.evaluate(() => globalThis.scrollY), before);
  const saved = await page.evaluate(() => JSON.parse(globalThis.localStorage.getItem('gallery:progress:beacon/v1/signal')));
  assert.equal(saved.n, 2);
});

test('手机长条阅读：途中查看页码、保留跳页草稿，并从气泡精确跳到目标页', { timeout: 120_000 }, async (t) => {
  const demo = await startDemo({ port: 0 });
  t.after(demo.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const chapter = 'http://127.0.0.1:' + demo.port + '/beacon/v1/signal/';
  await page.goto(chapter);
  const summary = page.locator('#long-jump summary');
  const input = page.getByRole('spinbutton', { name: '目标页码' });
  assert.equal(await summary.isVisible(), false);
  await page.locator('#settings-btn').tap();
  await page.getByRole('radio', { name: '长条' }).check();
  await page.goto(chapter + '#p1b0');
  await page.locator('#p1b0.hl').waitFor();
  await summary.tap();
  await input.fill('3');
  await input.press('Enter');
  assert.equal(await input.evaluate((el) => el.validity.rangeOverflow), true);
  assert.equal(new URL(page.url()).hash, '#p1b0');
  await input.fill('2');
  await input.press('Enter');
  const progressKey = 'gallery:progress:beacon/v1/signal';
  await page.waitForFunction((key) => JSON.parse(globalThis.localStorage.getItem(key)).n === 2, progressKey);
  assert.equal(new URL(page.url()).hash, '#p2');
  assert.equal(await page.locator('.box.hl').count(), 0);
  const pageTop = (await page.locator('#p2').boundingBox()).y;
  const barBottom = await page.locator('.topbar').evaluate((bar) => bar.getBoundingClientRect().bottom);
  assert.ok(Math.abs(pageTop - barBottom) <= 1, '第 2 页页首应贴在实际导航栏下方');
  assert.equal(await summary.evaluate((el) => el === el.ownerDocument.activeElement), true);

  const control = await summary.boundingBox();
  assert.ok(control.y >= barBottom && control.y + control.height <= 844, '途中可直接操作跳页入口');
  assert.ok((await page.locator('.pager').boundingBox()).y < 0, '原工具栏已在视口外');
  await summary.press('Space');
  await input.fill('2');
  await page.locator('#p1').evaluate((p) => p.scrollIntoView());
  await page.waitForFunction(() => globalThis.document.getElementById('long-page-number').textContent === '1');
  assert.equal(await input.inputValue(), '2', '滚动更新当前页时保留尚未提交的目标');
  await input.press('Escape');
  assert.equal(await input.isVisible(), false);
  assert.equal(new URL(page.url()).hash, '#p1');
  await summary.tap();
  assert.equal(await input.inputValue(), '');
  await input.fill('2');
  await page.getByRole('button', { name: '跳转', exact: true }).tap();
  await page.waitForFunction((key) => JSON.parse(globalThis.localStorage.getItem(key)).n === 2, progressKey);
  await page.goto(chapter);
  await page.waitForFunction(() => Math.abs(globalThis.document.getElementById('p2').getBoundingClientRect().top -
    globalThis.document.querySelector('.topbar').getBoundingClientRect().bottom) <= 1);
  assert.match(await summary.innerText(), /第 2 \/ 2 页/);
});
