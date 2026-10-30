import { getReaderBookmarkStore, FAVORITES_PREFIX, NOTE_PREFIX, MAX_NOTE_LENGTH } from './bookmarks.js';
import { createStorageRefresh } from './storage-refresh.js';

/** 页码来自原阅读器；编辑目标在打开时固定，不随翻页改变，也不自动写草稿。 */
export function mountReaderBookmarks(reader, root) {
  const core = reader.galleryReader;
  if (!core) return null;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const store = getReaderBookmarkStore(reader);
  const key = reader.dataset.key;
  const total = Number(reader.dataset.total);
  const page = root.querySelector('[data-bookmark-page]');
  const toggle = root.querySelector('[data-bookmark-toggle]');
  const edit = root.querySelector('[data-bookmark-edit]');
  const editor = root.querySelector('[data-bookmark-editor]');
  const editingPage = root.querySelector('[data-bookmark-editing-page]');
  const note = root.querySelector('[data-bookmark-note]');
  const currentNote = root.querySelector('[data-bookmark-current-note]');
  const save = root.querySelector('[data-bookmark-save]');
  const cancel = root.querySelector('[data-bookmark-cancel]');
  const message = root.querySelector('[data-bookmark-message]');
  let editing = null;
  let feedback = '';
  let destroyed = false;
  const storageRefresh = createStorageRefresh(win, () => refresh());
  const currentPage = () => {
    const n = core.getState().page;
    return Number.isSafeInteger(n) ? Math.min(total, Math.max(1, n)) : 1;
  };
  function refresh() {
    storageRefresh.cancel();
    if (destroyed) return;
    const n = currentPage();
    const mark = store.get(key, total, n);
    page.textContent = `第 ${n} 页`;
    toggle.textContent = mark ? '取消本页书签' : '收藏当前页';
    toggle.setAttribute('aria-pressed', String(Boolean(mark)));
    edit.textContent = mark?.note ? '编辑备注' : '添加备注';
    currentNote.hidden = !mark?.note;
    currentNote.textContent = mark?.note ?? '';
    message.textContent = store.limited ? '浏览器存储受限，未保存的书签修改仅在当前页面临时保留。' : feedback;
    root.hidden = false;
  }
  function report(result, success) {
    feedback = result.persisted ? success : '书签修改未能完整保存，仅在当前页面临时保留；离开或刷新后可能丢失。';
    refresh();
  }
  function closeEditor() {
    editing = null;
    editor.hidden = true;
  }
  const onToggle = () => {
    const n = currentPage();
    const marked = Boolean(store.get(key, total, n));
    if (marked) {
      if (editing === n) closeEditor();
      report(store.remove(key, total, n), `已移除第 ${n} 页书签。`);
    } else report(store.set(key, total, n), `已收藏第 ${n} 页。`);
    toggle.focus({ preventScroll: true });
  };
  const onEdit = () => {
    // 再次点击编辑时保留原草稿，避免误点丢失正在编辑的内容。
    if (editing === null) {
      editing = currentPage();
      note.value = store.get(key, total, editing)?.note ?? '';
      editingPage.textContent = `第 ${editing} 页`;
      editor.hidden = false;
    }
    note.focus();
  };
  const onSave = () => {
    if (editing === null) return;
    if (note.value.length > MAX_NOTE_LENGTH) {
      feedback = `备注最多 ${MAX_NOTE_LENGTH} 字符，请缩短后保存。`;
      refresh();
      note.focus();
      return;
    }
    const n = editing;
    const result = store.set(key, total, n, note.value);
    closeEditor();
    report(result, `已保存第 ${n} 页书签和备注。`);
    edit.focus({ preventScroll: true });
  };
  const onCancel = () => { closeEditor(); edit.focus({ preventScroll: true }); };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  const onStorage = (event) => {
    if (event.key === null || event.key === FAVORITES_PREFIX + key || event.key === NOTE_PREFIX + key + '/p' + currentPage()) storageRefresh.request();
  };
  const onShow = () => refresh();
  const unsubscribeReader = core.subscribe(refresh);
  const unsubscribeStore = store.subscribe(({ chapterKey }) => { if (chapterKey === key) refresh(); });
  toggle.addEventListener('click', onToggle);
  edit.addEventListener('click', onEdit);
  save.addEventListener('click', onSave);
  cancel.addEventListener('click', onCancel);
  editor.addEventListener('keydown', onKey);
  win.addEventListener('storage', onStorage);
  win.addEventListener('pageshow', onShow);
  win.addEventListener('focus', onShow);
  refresh();
  return {
    destroy() {
      destroyed = true;
      storageRefresh.destroy();
      unsubscribeReader();
      unsubscribeStore();
      toggle.removeEventListener('click', onToggle);
      edit.removeEventListener('click', onEdit);
      save.removeEventListener('click', onSave);
      cancel.removeEventListener('click', onCancel);
      editor.removeEventListener('keydown', onKey);
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('pageshow', onShow);
      win.removeEventListener('focus', onShow);
    },
  };
}
