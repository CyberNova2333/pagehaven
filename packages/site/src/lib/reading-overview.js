const LIBRARY_FIELDS = ['savedSeries', 'progressSeries', 'progressChapters'];
const BOOKMARK_FIELDS = ['bookmarks', 'notes'];

function snapshot(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const result = {};
    for (const field of fields) {
      const count = value[field];
      if (!Number.isSafeInteger(count) || count < 0) return null;
      result[field] = count;
    }
    const { limited, pending } = value;
    if (typeof limited !== 'boolean' || typeof pending !== 'boolean') return null;
    return { ...result, limited, pending };
  } catch { return null; }
}

/** 只消费两个视图的汇总，不重复读取浏览器存储，也不将数量当作备份总量。 */
export function mountReadingOverview(root) {
  const fields = Object.fromEntries([...LIBRARY_FIELDS, ...BOOKMARK_FIELDS].map((field) =>
    [field, root.querySelector(`[data-overview-field="${field}"]`)]));
  const status = root.querySelector('[data-overview-status]');
  const complete = Boolean(status && Object.values(fields).every(Boolean));
  let library = null;
  let bookmarks = null;
  let destroyed = false;

  const text = (node, value) => {
    if (node && node.textContent !== value) node.textContent = value;
  };
  function render() {
    for (const field of LIBRARY_FIELDS) text(fields[field], String(library?.[field] ?? '—'));
    for (const field of BOOKMARK_FIELDS) text(fields[field], String(bookmarks?.[field] ?? '—'));
    const ready = Boolean(complete && library && bookmarks);
    const hidden = !ready;
    if (root.hidden !== hidden) root.hidden = hidden;
    const message = [];
    if (ready) {
      message.push('当前目录可用记录');
      if (library.limited || bookmarks.limited) message.push('存储受限，数量可能不完整');
      if (library.pending || bookmarks.pending) message.push('含本页未保存修改');
    }
    text(status, message.length ? `${message.join('；')}。` : '');
  }
  function reset() {
    if (destroyed) return;
    library = bookmarks = null;
    render();
  }
  reset();

  return {
    updateLibrary(summary) {
      if (destroyed) return;
      library = snapshot(summary, LIBRARY_FIELDS);
      render();
    },
    updateBookmarks(summary) {
      if (destroyed) return;
      bookmarks = snapshot(summary, BOOKMARK_FIELDS);
      render();
    },
    reset,
    destroy() {
      if (destroyed) return;
      reset();
      destroyed = true;
    },
  };
}
