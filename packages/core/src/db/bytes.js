// 把「一段字节」的各种来历统一成 Uint8Array 视图（不复制）。
//
// 建库与分块摘要的输入既可能是 wasm 导出的 Uint8Array，也可能是构建脚本从磁盘读来的 Node Buffer、
// 或浏览器 fetch 回来的 ArrayBuffer。wasm 侧按 `constructor` 挑堆（Buffer 不在它认的列表里），
// crypto.subtle 又只认 BufferSource——在入口处统一成同一种形状，后面的代码就不用再各自分支。

/**
 * @param {Uint8Array | ArrayBuffer | ArrayBufferView} bytes
 * @returns {Uint8Array}
 */
export function asUint8(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    // 同一段内存换个视图：Buffer 可能是共享池里的一段，byteOffset 不为 0，必须带上
    return bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new TypeError('bytes 必须是 Uint8Array、ArrayBuffer 或其他 ArrayBufferView');
}
