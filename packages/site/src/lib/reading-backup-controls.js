import { readLibraryCatalog } from './library-controls.js';
import { MAX_BACKUP_BYTES, exportReadingBackup, parseReadingBackup, planReadingImport, applyReadingImport } from './reading-backup.js';

const TYPES = { library: '书架作品', progress: '阅读进度', bookmarks: '页码书签', notes: '书签备注' };

/** 备份只在本浏览器处理；选择文件仅预览，明确确认后才写入个人记录。 */
export function mountReadingBackup(root, options = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const getStorage = options.getStorage ?? (() => win.localStorage);
  const canTransfer = options.canTransfer ?? (() => '');
  const onImported = options.onImported ?? (() => {});
  const now = options.now ?? Date.now;
  const byId = (id) => root.querySelector(`#backup-${id}`);
  const exportButton = byId('export');
  const fileInput = byId('file');
  const mode = byId('mode');
  const preview = byId('preview');
  const summary = byId('summary');
  const details = byId('details');
  const apply = byId('apply');
  const cancel = byId('cancel');
  const refresh = byId('refresh');
  const feedback = byId('feedback');
  const downloadLink = byId('download');
  let catalog;
  let backup = null;
  let plan = null;
  let busy = false;
  let destroyed = false;
  let generation = 0;
  let objectUrl;

  const message = (text) => { feedback.textContent = text; };
  const countsText = (counts) => Object.entries(TYPES).map(([key, label]) => `${counts[key] ?? 0} 项${label}`).join('、');
  function blocked() {
    const reason = canTransfer();
    if (!reason) return false;
    message(reason);
    return true;
  }
  function setBusy(value) {
    busy = value;
    exportButton.disabled = fileInput.disabled = mode.disabled = refresh.disabled = value;
    apply.disabled = value || !plan || plan.changes === 0;
    root.setAttribute('aria-busy', String(value));
  }
  function clearPreview(clearFile = true) {
    generation += 1;
    backup = plan = null;
    if (clearFile) fileInput.value = '';
    mode.value = 'keep-existing';
    preview.hidden = true;
    refresh.hidden = true;
    apply.disabled = true;
    summary.replaceChildren();
    details.textContent = '';
  }
  function prepare() {
    plan = null;
    apply.disabled = true;
    if (!backup || blocked()) { refresh.hidden = !backup; return; }
    try {
      const candidate = planReadingImport(backup, getStorage(), { mode: mode.value, catalog });
      summary.replaceChildren(...Object.entries(TYPES).map(([key, label]) => {
        const count = candidate.counts[key];
        const row = doc.createElement('tr');
        for (const [index, text] of [label, count.added, count.updated, count.kept + count.same, count.repaired].entries()) {
          const cell = doc.createElement(index === 0 ? 'th' : 'td');
          if (index === 0) cell.setAttribute('scope', 'row');
          cell.textContent = String(text);
          row.append(cell);
        }
        return row;
      }));
      const date = new Date(backup.createdAt);
      const created = Number.isNaN(date.getTime()) ? '' : `备份时间：${date.toLocaleString('zh-CN')}。`;
      details.textContent = created + (candidate.unmatched
        ? ` ${candidate.unmatched} 条记录暂未匹配当前目录，仍会保留；相应内容恢复后可再次显示。` : ' 记录将按作品与章节标识恢复。');
      plan = candidate;
      preview.hidden = false;
      refresh.hidden = true;
      message(candidate.changes ? '请核对下方预览，确认后再导入。当前记录尚未更改。' : '备份内容均已存在或为空，无需导入。可切换重复记录处理方式后重新核对。');
      apply.disabled = busy || candidate.changes === 0;
    } catch (error) {
      preview.hidden = true;
      refresh.hidden = false;
      message(error.message || '无法预览，请检查浏览器是否允许读取站点数据。');
    }
  }
  function download(text, name) {
    if (options.download) { options.download(text, name); return; }
    const blob = new win.Blob([text], { type: 'application/json;charset=utf-8' });
    if (blob.size > MAX_BACKUP_BYTES) throw new Error('备份超过 5 MiB 限制，请减少记录后重试。');
    const nextUrl = win.URL.createObjectURL(blob);
    if (objectUrl) win.URL.revokeObjectURL(objectUrl);
    objectUrl = nextUrl;
    downloadLink.href = objectUrl;
    downloadLink.download = name;
    downloadLink.hidden = false;
    downloadLink.click();
  }
  const onExport = () => {
    if (busy || blocked()) return;
    try {
      const result = exportReadingBackup(getStorage(), { now });
      const text = JSON.stringify(result.backup);
      download(text, `pagehaven-reading-backup-${new Date(result.backup.createdAt).toISOString().slice(0, 10)}.json`);
      message(`已生成备份：${countsText(result.counts)}。` + (result.skipped ? `另有 ${result.skipped} 条损坏记录未导出。` : '') + ' 请保管下载文件，内容不会上传。');
    } catch (error) { message(error.message || '无法生成备份，请检查浏览器存储与下载权限。'); }
  };
  const onFile = async () => {
    if (busy) return;
    const file = fileInput.files?.[0];
    clearPreview(false);
    if (!file) return;
    if (blocked()) { fileInput.value = ''; return; }
    const ticket = generation;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BACKUP_BYTES) { message('备份文件不能超过 5 MiB。'); return; }
    setBusy(true);
    message('正在读取备份，只会生成预览…');
    try {
      const text = await file.text();
      if (destroyed || ticket !== generation) return;
      backup = parseReadingBackup(text);
      prepare();
    } catch (error) {
      if (!destroyed && ticket === generation) message(error.message || '无法读取备份文件，请重新选择。');
    } finally { if (!destroyed && ticket === generation) setBusy(false); }
  };
  const onApply = () => {
    if (busy || !plan || blocked()) return;
    setBusy(true);
    try {
      const result = applyReadingImport(plan, getStorage());
      plan = null;
      if (result.ok) {
        let refreshed = true;
        try { onImported(); } catch { refreshed = false; }
        clearPreview();
        message(refreshed ? '导入完成，书架、页码书签和阅读进度已更新。' : '数据已导入，请刷新页面查看更新后的书架与书签。');
      } else {
        refresh.hidden = false;
        if (result.rolledBack === false) {
          try { onImported(); } catch { /* 存储结果仍按实际部分失败报告。 */ }
          message('导入未完成，部分记录可能已改变，且未能全部恢复。请先核对书架并备份当前记录，再重新预览。');
        } else message(result.reason === 'changed'
          ? '预览后记录已被其他窗口修改，未完成导入。请重新预览后再确认。'
          : '浏览器未能保存备份，已撤销本次写入。请检查存储权限或可用空间，再重新预览。');
      }
    } catch (error) {
      plan = null;
      refresh.hidden = false;
      message(error.message || '导入未完成，请重新核对当前记录并预览。');
    } finally { setBusy(false); }
  };
  const onCancel = () => { if (busy) return; clearPreview(); message('已关闭本次导入预览。'); };
  const onMode = () => { if (!busy) prepare(); };
  try { catalog = readLibraryCatalog(doc.getElementById('library-catalog')); }
  catch { root.hidden = false; exportButton.disabled = fileInput.disabled = true; message('站点目录暂时无法读取，请刷新页面后再试。'); return; }
  exportButton.addEventListener('click', onExport);
  fileInput.addEventListener('change', onFile);
  mode.addEventListener('change', onMode);
  refresh.addEventListener('click', onMode);
  apply.addEventListener('click', onApply);
  cancel.addEventListener('click', onCancel);
  root.hidden = false;
  return {
    destroy() {
      destroyed = true; generation += 1;
      exportButton.removeEventListener('click', onExport);
      fileInput.removeEventListener('change', onFile);
      mode.removeEventListener('change', onMode);
      refresh.removeEventListener('click', onMode);
      apply.removeEventListener('click', onApply);
      cancel.removeEventListener('click', onCancel);
      if (objectUrl) win.URL.revokeObjectURL(objectUrl);
    },
  };
}
