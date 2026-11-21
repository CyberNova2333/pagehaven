// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Pagehaven · 页间 and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
// 只读 HTTP Range 分块 SQLite VFS 适配层：把同步块读取函数（例如 SyncChunkedFile.read）
// 挂成 @sqlite.org/sqlite-wasm 的自定义 sqlite3_vfs，免去 30 MiB 整库加载上限。
//
// 为什么在同一个 sqlite3 实例上只注册一次 VFS：wasm 里的 VFS 链表与 C 结构体是全局状态，
// 复用单一 'pagehaven-range' VFS、按虚拟路径区分打开的 DB，能避免重复分配 C 结构体或注销泄漏。
import { initSqlite } from './build.js';

export const RANGE_VFS_NAME = 'pagehaven-range';
const VALID_SECTOR_SIZES = new Set([512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]);

/** @type {WeakMap<object, { filesByPath: Map<string, object>, handles: Map<number, object>, nextId: number }>} */
const vfsStates = new WeakMap();
/** @type {WeakMap<object, object>} */
const dbEntries = new WeakMap();

function stripUri(rawName) {
  const q = rawName.indexOf('?');
  return q >= 0 ? rawName.slice(0, q) : rawName;
}

function ensureRangeVfs(sqlite3) {
  const existing = vfsStates.get(sqlite3);
  if (existing) return existing;

  const { capi, wasm } = sqlite3;
  const state = { filesByPath: new Map(), handles: new Map(), nextId: 0 };
  const io = new capi.sqlite3_io_methods();
  io.$iVersion = 1;
  const vfs = new capi.sqlite3_vfs();
  vfs.$iVersion = 1;
  vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  vfs.$mxPathname = 512;

  sqlite3.vfs.installVfs({
    io: {
      struct: io,
      methods: {
        xClose(pFile) {
          state.handles.delete(pFile);
          return 0;
        },
        xRead(pFile, pDest, n, offset64) {
          const entry = state.handles.get(pFile);
          if (!entry) return capi.SQLITE_IOERR_READ;
          const offset = Number(offset64);
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(n) || n < 0) {
            entry.lastError = new RangeError(`VFS 收到非法读取区间 [${offset64}, +${n})`);
            return capi.SQLITE_IOERR_READ;
          }
          const available = Math.max(0, Math.min(entry.totalBytes, offset + n) - offset);
          if (available > 0) {
            try {
              const bytes = entry.readSync(offset, available);
              if (!(bytes instanceof Uint8Array) || bytes.byteLength !== available) {
                entry.lastError = new Error(
                  `VFS 读取 [${offset}, ${offset + available}) 返回 ${bytes?.byteLength ?? 'invalid'} 字节，预期 ${available}`,
                );
                return capi.SQLITE_IOERR_READ;
              }
              wasm.heap8u().set(bytes, Number(pDest));
            } catch (e) {
              entry.lastError = e;
              return capi.SQLITE_IOERR_READ;
            }
          }
          if (available < n) {
            wasm.heap8u().fill(0, Number(pDest) + available, Number(pDest) + n);
            return capi.SQLITE_IOERR_SHORT_READ;
          }
          return 0;
        },
        xWrite() {
          return capi.SQLITE_READONLY;
        },
        xTruncate() {
          return capi.SQLITE_READONLY;
        },
        xSync() {
          return 0;
        },
        xFileSize(pFile, pSize) {
          const entry = state.handles.get(pFile);
          if (!entry) return capi.SQLITE_IOERR_FSTAT;
          wasm.poke(pSize, entry.totalBytes, 'i64');
          return 0;
        },
        xLock() {
          return 0;
        },
        xUnlock() {
          return 0;
        },
        xCheckReservedLock(_pFile, pOut) {
          wasm.poke32(pOut, 0);
          return 0;
        },
        xFileControl() {
          return capi.SQLITE_NOTFOUND;
        },
        xSectorSize(pFile) {
          return state.handles.get(pFile)?.sectorSize ?? 4096;
        },
        xDeviceCharacteristics() {
          return capi.SQLITE_IOCAP_IMMUTABLE;
        },
      },
    },
    vfs: {
      struct: vfs,
      name: RANGE_VFS_NAME,
      methods: {
        xOpen(_pVfs, zName, pFile, _flags, pOutFlags) {
          if (!zName) return capi.SQLITE_CANTOPEN;
          const path = stripUri(wasm.cstrToJs(zName));
          const entry = state.filesByPath.get(path);
          if (!entry) return capi.SQLITE_CANTOPEN;
          state.handles.set(pFile, entry);
          const f = new capi.sqlite3_file(pFile);
          f.$pMethods = io.pointer;
          f.dispose();
          if (pOutFlags) wasm.poke32(pOutFlags, capi.SQLITE_OPEN_READONLY);
          return 0;
        },
        xDelete() {
          return capi.SQLITE_READONLY;
        },
        xAccess(_pVfs, zName, flags, pOut) {
          const path = zName ? stripUri(wasm.cstrToJs(zName)) : '';
          const writable = (flags & capi.SQLITE_ACCESS_READWRITE) !== 0;
          wasm.poke32(pOut, !writable && state.filesByPath.has(path) ? 1 : 0);
          return 0;
        },
        xFullPathname(_pVfs, zName, nOut, pOut) {
          return wasm.cstrncpy(pOut, zName, nOut) < nOut ? 0 : capi.SQLITE_CANTOPEN;
        },
        xRandomness(_pVfs, n, pOut) {
          const heap = wasm.heap8u();
          const base = Number(pOut);
          if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            crypto.getRandomValues(heap.subarray(base, base + n));
          } else {
            for (let i = 0; i < n; i++) heap[base + i] = (Math.random() * 256) & 0xff;
          }
          return n;
        },
        xSleep() {
          return 0;
        },
        xCurrentTime(_pVfs, pOut) {
          wasm.poke(pOut, 2440587.5 + Date.now() / 864e5, 'double');
          return 0;
        },
        xGetLastError() {
          return 0;
        },
      },
    },
  });

  vfsStates.set(sqlite3, state);
  return state;
}

/**
 * 取出并清空当前分段库在最近一次 xRead 里捕获到的底层错误（例如 ChunkFetchError('needs-whole')）。
 * SQLite C API 只能向 JS 抛 SQLITE_IOERR_READ，调用方借此取回真正的失败原因与错误码。
 * @param {object} db
 * @returns {unknown}
 */
export function consumeChunkedDbError(db) {
  const entry = dbEntries.get(db);
  if (!entry) return null;
  const err = entry.lastError;
  entry.lastError = null;
  return err;
}

/**
 * 通过只读 Range VFS 打开一份远端（或分块）SQLite 库。
 * 打开时立即探测 sqlite_master；若头部字节不是合法 sqlite 或底层 readSync 抛错，当场拒绝并清理。
 *
 * @param {{ readSync: (offset: number, length: number) => Uint8Array, totalBytes: number, sectorSize?: number }} opts
 * @returns {Promise<import('@sqlite.org/sqlite-wasm').Database>}
 */
export async function openChunkedGalleryDb({ readSync, totalBytes, sectorSize = 4096 }) {
  if (typeof readSync !== 'function') throw new TypeError('readSync 必须是同步读取函数');
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new RangeError(`totalBytes 必须是正整数，收到 ${totalBytes}`);
  }
  if (!VALID_SECTOR_SIZES.has(sectorSize)) {
    throw new RangeError(`sectorSize 必须是 512–65536 之间的 2 的幂，收到 ${sectorSize}`);
  }

  const sqlite3 = await initSqlite();
  const state = ensureRangeVfs(sqlite3);
  state.nextId += 1;
  const path = `/gallery-range-${state.nextId}.sqlite`;
  const entry = { readSync, totalBytes, sectorSize, lastError: null };
  state.filesByPath.set(path, entry);

  let db = null;
  let closed = false;
  try {
    db = new sqlite3.oo1.DB(`file:${path}?immutable=1`, 'r', RANGE_VFS_NAME);
    const origClose = db.close.bind(db);
    db.close = () => {
      if (closed) return;
      closed = true;
      state.filesByPath.delete(path);
      dbEntries.delete(db);
      return origClose();
    };
    dbEntries.set(db, entry);
    db.selectValue('SELECT count(*) FROM sqlite_master');
    return db;
  } catch (e) {
    const underlying = entry.lastError;
    entry.lastError = null;
    try {
      db?.close();
    } catch {
      /* 忽略关闭时的连带清理异常 */
    }
    state.filesByPath.delete(path);
    throw underlying ?? e;
  }
}
