import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountReadingBackup } from '../src/lib/reading-backup-controls.js';
import { MAX_BACKUP_BYTES } from '../src/lib/reading-backup.js';

const chapterKey = 'sample/v/c';
const libraryKey = 'gallery:library:sample';
const progressKey = `gallery:progress:${chapterKey}`;
const favoriteKey = `gallery:favorites:${chapterKey}`;
const noteKey = `gallery:bookmark-note:${chapterKey}/p1`;
const bookmarkId = (n) => `${chapterKey}/p${n}`;
const libraryEntry = (status, updatedAt = 1) => ({ version: 1, status, updatedAt });
const noteEntry = (note, updatedAt = 1) => ({ version: 1, note, updatedAt });

function backup(overrides = {}) {
  return {
    format: 'pagehaven-reading-backup', version: 1, createdAt: 1000,
    library: [{ seriesId: 'sample', status: 'reading', updatedAt: 10 }],
    progress: [{ chapterKey, n: 3, ts: 11 }],
    bookmarks: [{ chapterKey, pages: [1, 2] }],
    notes: [{ chapterKey, n: 1, note: '<b>备份备注</b>', updatedAt: 12 }],
    ...overrides,
  };
}

// 仅模拟控制器使用的标准 DOM 接口；读写计划、格式校验与回滚执行真实模型。
function element(tag = '') {
  const listeners = new Map();
  const attributes = new Map();
  let text = '';
  return {
    tag, children: [], hidden: false, disabled: false, value: '', files: [],
    get textContent() { return text + this.children.map((child) => child.textContent).join(''); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { throw new Error('备份内容不得解析为 HTML'); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ''; this.children = [...children]; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    fire(type) { return Promise.all([...listeners.get(type) ?? []].map((listener) => listener({ target: this }))); },
    click() { return this.fire('click'); },
  };
}

function fixture({ records = {}, canTransfer = () => '', onImported = () => {} } = {}) {
  const values = new Map(Object.entries(records).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const storage = {
    values, reads: [], writes: [], readDenied: false, writeDenied: false,
    get length() { if (this.readDenied) throw new Error('storage denied'); return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) {
      this.reads.push(key);
      if (this.readDenied) throw new Error('storage denied');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.writeDenied) throw new Error('storage quota');
      this.writes.push(['set', key]); values.set(key, value);
    },
    removeItem(key) {
      if (this.writeDenied) throw new Error('storage denied');
      this.writes.push(['remove', key]); values.delete(key);
    },
  };
  const names = ['export', 'file', 'mode', 'preview', 'summary', 'details', 'apply', 'cancel', 'refresh', 'feedback', 'download'];
  const nodes = Object.fromEntries(names.map((name) => [name, element(name)]));
  nodes.mode.value = 'keep-existing';
  nodes.preview.hidden = nodes.refresh.hidden = nodes.download.hidden = true;
  nodes.apply.disabled = true;
  const root = element('section');
  root.hidden = true;
  root.querySelector = (selector) => nodes[selector.slice('#backup-'.length)] ?? null;
  const catalog = element('script');
  catalog.textContent = JSON.stringify([{ id: 'sample', title: '示例作品', url: '/sample/', coverUrl: null, authors: [],
    issues: [{ id: 'v', title: '第一卷', chapters: [{ key: chapterKey, title: '开端', url: `/${chapterKey}/`, pages: 6 }] }] }]);
  const doc = { defaultView: { localStorage: storage }, getElementById: (id) => id === 'library-catalog' ? catalog : null, createElement: element };
  root.ownerDocument = doc;
  const downloads = [];
  let imported = 0;
  const controller = mountReadingBackup(root, {
    getStorage: () => storage, canTransfer, now: () => 1000,
    download: (text, filename) => downloads.push({ text, filename }),
    onImported: () => { imported += 1; onImported(); },
  });
  const select = async (data = backup()) => {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    nodes.file.files = [{ size: new TextEncoder().encode(text).length, text: async () => text }];
    nodes.file.value = 'reading-backup.json';
    await nodes.file.fire('change');
  };
  return { root, nodes, storage, downloads, controller, select, get imported() { return imported; } };
}

test('选择备份只预览不写，确认后恢复全部类型并刷新当前界面', async () => {
  const f = fixture();
  assert.equal(f.root.hidden, false);
  await f.select();
  assert.equal(f.nodes.preview.hidden, false);
  assert.equal(f.nodes.apply.disabled, false);
  assert.equal(f.nodes.summary.children.length, 4);
  assert.match(f.nodes.feedback.textContent, /尚未更改/);
  assert.deepEqual(f.storage.writes, []);
  assert.equal(f.imported, 0);
  await f.nodes.apply.fire('click');
  assert.equal(JSON.parse(f.storage.values.get(libraryKey)).status, 'reading');
  assert.equal(JSON.parse(f.storage.values.get(progressKey)).n, 3);
  assert.deepEqual(JSON.parse(f.storage.values.get(favoriteKey)), [bookmarkId(1), bookmarkId(2)]);
  assert.equal(JSON.parse(f.storage.values.get(noteKey)).note, '<b>备份备注</b>');
  assert.equal(f.imported, 1);
  assert.equal(f.nodes.preview.hidden, true);
  assert.equal(f.nodes.apply.disabled, true);
  assert.match(f.nodes.feedback.textContent, /导入完成/);
  const written = f.storage.writes.length;
  await f.nodes.apply.fire('click');
  assert.equal(f.storage.writes.length, written, '确认后的旧计划不能再次执行');
  assert.equal(f.imported, 1);
});

test('默认保留当前记录，明确切换使用备份后更新预览并只覆盖同项', async () => {
  const f = fixture({ records: {
    [libraryKey]: libraryEntry('want'),
    [progressKey]: { url: `/${chapterKey}/`, n: 1, ts: 1 },
    [favoriteKey]: [bookmarkId(3)],
    [noteKey]: noteEntry('本机备注'),
    'gallery:library:other': libraryEntry('read'),
  } });
  await f.select();
  assert.equal(f.nodes.mode.value, 'keep-existing');
  assert.deepEqual(f.nodes.summary.children[0].children.map((cell) => cell.textContent), ['书架作品', '0', '0', '1', '0']);
  assert.deepEqual(f.storage.writes, []);
  f.nodes.mode.value = 'use-backup';
  await f.nodes.mode.fire('change');
  assert.deepEqual(f.nodes.summary.children[0].children.map((cell) => cell.textContent), ['书架作品', '0', '1', '0', '0']);
  assert.deepEqual(f.storage.writes, [], '切换策略仍然只是预览');
  await f.nodes.apply.fire('click');
  assert.equal(JSON.parse(f.storage.values.get(libraryKey)).status, 'reading');
  assert.equal(JSON.parse(f.storage.values.get(noteKey)).note, '<b>备份备注</b>');
  assert.deepEqual(JSON.parse(f.storage.values.get(favoriteKey)), [bookmarkId(1), bookmarkId(2), bookmarkId(3)]);
  assert.equal(JSON.parse(f.storage.values.get('gallery:library:other')).status, 'read');
});

test('保留当前策略确实保留已有状态进度备注，取消预览不写任何数据', async () => {
  const original = { [libraryKey]: libraryEntry('read'), [noteKey]: noteEntry('现有备注'),
    [progressKey]: { url: `/${chapterKey}/`, n: 5, ts: 20 } };
  const kept = fixture({ records: original });
  await kept.select();
  await kept.nodes.apply.fire('click');
  assert.equal(JSON.parse(kept.storage.values.get(libraryKey)).status, 'read');
  assert.equal(JSON.parse(kept.storage.values.get(noteKey)).note, '现有备注');
  assert.equal(JSON.parse(kept.storage.values.get(progressKey)).n, 5);
  const cancelled = fixture({ records: original });
  await cancelled.select();
  await cancelled.nodes.cancel.fire('click');
  assert.equal(cancelled.nodes.preview.hidden, true);
  assert.equal(cancelled.nodes.apply.disabled, true);
  assert.equal(cancelled.nodes.file.value, '');
  await cancelled.nodes.apply.fire('click');
  assert.deepEqual(cancelled.storage.writes, []);
  assert.equal(cancelled.imported, 0);
});

test('文件超限在读取前拒绝，错误文件及存储受限均不会报告成功', async () => {
  const f = fixture();
  let reads = 0;
  f.nodes.file.files = [{ size: MAX_BACKUP_BYTES + 1, text: async () => { reads++; return '{}'; } }];
  await f.nodes.file.fire('change');
  assert.equal(reads, 0);
  assert.match(f.nodes.feedback.textContent, /5 MiB/);
  await f.select('{ not JSON');
  assert.match(f.nodes.feedback.textContent, /JSON/);
  assert.equal(f.nodes.preview.hidden, true);
  assert.equal(f.nodes.apply.disabled, true);
  f.storage.readDenied = true;
  await f.select();
  assert.equal(f.nodes.preview.hidden, true);
  assert.equal(f.nodes.apply.disabled, true);
  assert.equal(f.nodes.refresh.hidden, false);
  assert.doesNotMatch(f.nodes.feedback.textContent, /导入完成|已生成备份|请核对下方/);
  await f.nodes.export.fire('click');
  assert.deepEqual(f.downloads, []);
  assert.doesNotMatch(f.nodes.feedback.textContent, /导入完成|已生成备份/);
  assert.deepEqual(f.storage.writes, []);
});

test('导出合法阅读数据为JSON，报告损坏记录且不读取其他存储值', async () => {
  const f = fixture({ records: {
    [libraryKey]: libraryEntry('reading'),
    [progressKey]: { url: `/${chapterKey}/`, n: 2, ts: 2, title: '旧标题' },
    [favoriteKey]: [bookmarkId(1)], [noteKey]: noteEntry('已保存备注'),
    'gallery:library:broken': '{invalid', 'private:session': 'not-reading-data',
  } });
  await f.nodes.export.fire('click');
  assert.equal(f.downloads.length, 1);
  const data = JSON.parse(f.downloads[0].text);
  assert.equal(data.format, 'pagehaven-reading-backup');
  assert.equal(data.library[0].status, 'reading');
  assert.equal(data.notes[0].note, '已保存备注');
  assert.doesNotMatch(f.downloads[0].text, /private:session|not-reading-data|旧标题/);
  assert.match(f.downloads[0].filename, /^pagehaven-reading-backup-1970-01-01\.json$/);
  assert.match(f.nodes.feedback.textContent, /1 条损坏记录/);
  assert.equal(f.storage.reads.includes('private:session'), false);
  assert.deepEqual(f.storage.writes, []);
});

test('临时修改或正在编辑的备注阻止导出、选择与确认，不丢弃本页状态', async () => {
  let reason = '请先保存本页临时修改';
  const f = fixture({ canTransfer: () => reason });
  await f.nodes.export.fire('click');
  await f.select();
  assert.match(f.nodes.feedback.textContent, /临时修改/);
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(f.storage.writes, []);
  reason = '';
  await f.select();
  reason = '请先保存或取消正在编辑的备注';
  await f.nodes.apply.fire('click');
  assert.match(f.nodes.feedback.textContent, /正在编辑/);
  assert.deepEqual(f.storage.writes, []);
  assert.equal(f.imported, 0);
  assert.equal(f.nodes.preview.hidden, false);
});

test('预览后其他窗口修改触发重新预览，保留更新且不执行过期计划', async () => {
  const f = fixture();
  await f.select();
  f.storage.values.set(libraryKey, JSON.stringify(libraryEntry('read', 30)));
  await f.nodes.apply.fire('click');
  assert.match(f.nodes.feedback.textContent, /其他窗口修改.*重新预览/);
  assert.equal(f.nodes.apply.disabled, true);
  assert.equal(f.nodes.refresh.hidden, false);
  assert.deepEqual(f.storage.writes, []);
  await f.nodes.refresh.fire('click');
  assert.equal(f.nodes.apply.disabled, false);
  await f.nodes.apply.fire('click');
  assert.equal(JSON.parse(f.storage.values.get(libraryKey)).status, 'read');
  assert.equal(f.imported, 1);
});

test('保存失败保留重新预览入口，恢复存储后再次确认才能成功', async () => {
  const f = fixture();
  await f.select();
  f.storage.writeDenied = true;
  await f.nodes.apply.fire('click');
  assert.match(f.nodes.feedback.textContent, /未能保存.*重新预览/);
  assert.equal(f.nodes.apply.disabled, true);
  assert.equal(f.nodes.refresh.hidden, false);
  assert.equal(f.imported, 0);
  assert.equal(f.storage.values.size, 0);
  f.storage.writeDenied = false;
  await f.nodes.refresh.fire('click');
  assert.equal(f.imported, 0, '刷新预览不应直接导入');
  await f.nodes.apply.fire('click');
  assert.equal(f.imported, 1);
  assert.match(f.nodes.feedback.textContent, /导入完成/);
});

test('销毁期间未完成的文件读取不能更新界面或重新挂上操作', async () => {
  const f = fixture();
  let resolveText;
  const text = new Promise((resolve) => { resolveText = resolve; });
  f.nodes.file.files = [{ size: 100, text: () => text }];
  const reading = f.nodes.file.fire('change');
  assert.equal(f.root.getAttribute('aria-busy'), 'true');
  f.controller.destroy();
  const message = f.nodes.feedback.textContent;
  resolveText(JSON.stringify(backup()));
  await reading;
  assert.equal(f.nodes.feedback.textContent, message);
  assert.equal(f.nodes.preview.hidden, true);
  assert.equal(f.nodes.summary.children.length, 0);
  await f.nodes.export.fire('click');
  await f.nodes.apply.fire('click');
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(f.storage.writes, []);
});

test('显示刷新回调异常不掩盖已成功保存的数据，也不虚报导入失败', async () => {
  const f = fixture({ onImported: () => { throw new Error('view unavailable'); } });
  await f.select();
  await f.nodes.apply.fire('click');
  assert.equal(f.imported, 1);
  assert.equal(JSON.parse(f.storage.values.get(libraryKey)).status, 'reading');
  assert.match(f.nodes.feedback.textContent, /数据已导入.*刷新页面/);
  assert.doesNotMatch(f.nodes.feedback.textContent, /导入未完成|未能保存|失败/);
  assert.equal(f.nodes.apply.disabled, true);
});
