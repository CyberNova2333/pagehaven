import { createBookmarkStore, FAVORITES_PREFIX, NOTE_PREFIX, MAX_NOTE_LENGTH } from './bookmarks.js';
import { readLibraryCatalog } from './library-controls.js';
import { createStorageRefresh } from './storage-refresh.js';

/** 页书签独立于作品书架；只把当前目录中的收藏呈现为站内页码链接。 */
export function mountBookmarkLibrary(root, options = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const store = options.store ?? createBookmarkStore({ getStorage: () => win.localStorage });
  const list = root.querySelector('#bookmark-list');
  const empty = root.querySelector('#bookmark-empty');
  const filter = root.querySelector('#bookmark-filter');
  const count = root.querySelector('#bookmark-count');
  const storageNote = root.querySelector('#bookmark-storage-note');
  const feedback = root.querySelector('#bookmark-feedback');
  const more = root.querySelector('#bookmark-more');
  const editor = root.querySelector('#bookmark-editor');
  const editorTitle = root.querySelector('#bookmark-editor-title');
  const note = root.querySelector('#library-bookmark-note');
  const save = root.querySelector('#bookmark-save');
  const cancel = root.querySelector('#bookmark-cancel');
  let catalog;
  try { catalog = readLibraryCatalog(doc.getElementById('library-catalog')); }
  catch { empty.textContent = '书签目录暂时无法读取，请刷新页面重试。'; return; }
  let rows = [];
  let limit = 50;
  let editing = null;
  let writing = false;
  let destroyed = false;
  const storageRefresh = createStorageRefresh(win, () => refresh());
  const element = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const rowId = (row) => `${row.chapter.key}/p${row.n}`;
  function limited() {
    storageNote.hidden = !store.limited;
    storageNote.textContent = store.limited ? '浏览器存储受限，未保存的书签修改仅在当前页面临时保留。' : '';
  }
  function focusRow(id, action) {
    const target = [...list.querySelectorAll('[data-bookmark-id]')].find((item) => item.dataset.bookmarkId === id);
    const control = target?.querySelector(`[data-bookmark-action="${action}"]`);
    (control ?? filter).focus({ preventScroll: true });
  }
  function closeEditor() {
    const id = editing ? rowId(editing) : null;
    editing = null;
    editor.hidden = true;
    if (id) focusRow(id, 'edit');
  }
  function perform(action, message) {
    writing = true;
    let result;
    try { result = action(); } finally { writing = false; }
    refresh();
    feedback.textContent = result.persisted ? message : '书签修改未能完整保存，仅在当前页面临时保留；离开或刷新后可能丢失。';
  }
  function card(row) {
    const item = element('li', undefined, 'bookmark-row card card-pad');
    item.dataset.bookmarkId = rowId(row);
    const heading = element('h3');
    const read = element('a', `${row.series.title} · ${row.chapter.title} · 第 ${row.n} 页`);
    read.dataset.bookmarkAction = 'read';
    read.href = `${row.chapter.url}#p${row.n}`;
    heading.append(read);
    item.append(heading, element('p', row.issue.title, 'muted'));
    if (row.note) item.append(element('p', row.note, 'bookmark-body'));
    const actions = element('div', undefined, 'library-item-actions');
    const edit = element('button', row.note ? '编辑备注' : '添加备注', 'btn');
    edit.type = 'button';
    edit.dataset.bookmarkAction = 'edit';
    edit.addEventListener('click', () => {
      // 切换目标前保留正在编辑的草稿；保存或取消后再选择另一条。
      if (editing === null) {
        editing = row;
        editorTitle.textContent = `${row.series.title} · ${row.chapter.title} · 第 ${row.n} 页`;
        note.value = row.note;
        editor.hidden = false;
      }
      note.focus();
    });
    const remove = element('button', '移除书签', 'btn');
    remove.type = 'button';
    remove.dataset.bookmarkAction = 'remove';
    remove.setAttribute('aria-label', `移除${row.series.title}第 ${row.n} 页书签`);
    remove.addEventListener('click', () => {
      if (editing && rowId(editing) === rowId(row)) { editing = null; editor.hidden = true; }
      perform(() => store.remove(row.chapter.key, row.chapter.pages, row.n), '已移除书签，阅读进度和作品收藏仍会保留。');
      filter.focus({ preventScroll: true });
    });
    actions.append(edit, remove);
    item.append(actions);
    return item;
  }
  function render() {
    const active = doc.activeElement;
    const activeRow = list.contains(active) ? active.closest('[data-bookmark-id]') : null;
    const focusedId = activeRow?.dataset.bookmarkId;
    const focusedAction = active?.dataset.bookmarkAction;
    const matches = rows.filter((row) => !filter.value || row.series.id === filter.value);
    list.replaceChildren(...matches.slice(0, limit).map(card));
    list.hidden = matches.length === 0;
    empty.hidden = matches.length > 0;
    empty.textContent = rows.length ? '这部作品还没有页码书签。可选择其他作品，或在阅读页收藏。'
      : '还没有页码书签。在阅读页点击“收藏当前页”，以后可从这里快速回到喜欢的画面。';
    count.textContent = `共 ${rows.length} 个书签 · 显示 ${Math.min(limit, matches.length)} / ${matches.length} 个`;
    more.hidden = matches.length <= limit;
    limited();
    if (focusedId && focusedAction) focusRow(focusedId, focusedAction);
  }
  function refresh() {
    storageRefresh.cancel();
    if (destroyed) return;
    rows = catalog.flatMap((series) => series.issues.flatMap((issue) => issue.chapters.flatMap((chapter) =>
      store.list(chapter.key, chapter.pages).map((mark) => ({ ...mark, series, issue, chapter })))));
    render();
  }
  const onSave = () => {
    if (!editing) return;
    if (note.value.length > MAX_NOTE_LENGTH) {
      feedback.textContent = `备注最多 ${MAX_NOTE_LENGTH} 字符，请缩短后保存。`;
      note.focus();
      return;
    }
    const target = editing;
    perform(() => store.set(target.chapter.key, target.chapter.pages, target.n, note.value), `已保存第 ${target.n} 页书签和备注。`);
    closeEditor();
  };
  const onCancel = () => closeEditor();
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); closeEditor();
  };
  const onFilter = () => { limit = 50; render(); };
  const onMore = () => { limit += 50; render(); more.hidden ? filter.focus() : more.focus(); };
  const onStorage = (event) => {
    if (event.key === null || event.key?.startsWith(FAVORITES_PREFIX) || event.key?.startsWith(NOTE_PREFIX)) storageRefresh.request();
  };
  const onShow = () => refresh();
  const unsubscribe = store.subscribe(() => { if (!writing) refresh(); });
  filter.addEventListener('change', onFilter);
  more.addEventListener('click', onMore);
  save.addEventListener('click', onSave);
  cancel.addEventListener('click', onCancel);
  editor.addEventListener('keydown', onKey);
  win.addEventListener('storage', onStorage);
  win.addEventListener('pageshow', onShow);
  win.addEventListener('focus', onShow);
  root.querySelector('[data-bookmark-toolbar]').hidden = false;
  refresh();
  return {
    get hasPending() { return store.hasPending; },
    get isEditing() { return Boolean(editing); },
    destroy() {
      destroyed = true;
      storageRefresh.destroy();
      unsubscribe();
      filter.removeEventListener('change', onFilter);
      more.removeEventListener('click', onMore);
      save.removeEventListener('click', onSave);
      cancel.removeEventListener('click', onCancel);
      editor.removeEventListener('keydown', onKey);
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('pageshow', onShow);
      win.removeEventListener('focus', onShow);
    },
  };
}
