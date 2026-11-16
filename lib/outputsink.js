/**
 * 输出文件落盘（OPFS）。
 *
 * 和分片目录分开存：分片目录在任务完成后会被整个删掉，而输出文件要一直活到
 * 用户真正保存下载为止。写 mdat 时只是顺序 append，内存里不留下数据。
 */

import { sanitizeName } from './media.js';

/** 重封装产物的落盘目录（与分片目录分开，避免被续传清理误删） */
const OUT_DIR = 'vd-out';

/**
 * @returns {{name, write, close, abort, file}} sink 只暴露追加写与关闭
 */
export async function openOutputSink(key, ext = 'mp4') {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OUT_DIR, { create: true });
  const name = `${sanitizeName(key, 'out')}.${ext}`;
  const fh = await dir.getFileHandle(name, { create: true });
  const writer = await fh.createWritable();
  let done = false;
  return {
    name,
    write: (bytes) => writer.write(bytes),
    async close() {
      if (done) return;
      done = true;
      await writer.close();
    },
    async abort() {
      if (done) return;
      done = true;
      try {
        await writer.abort();
      } catch {
        /* 已经关了 */
      }
    },
    file: () => fh.getFile()
  };
}

export async function dropOutputFile(key, ext = 'mp4') {
  if (!key) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OUT_DIR);
    await dir.removeEntry(`${sanitizeName(key, 'out')}.${ext}`);
  } catch {
    /* 不存在就算了 */
  }
}

/** 把 Blob / Uint8Array 统一成 Uint8Array */
export async function partBytes(part) {
  if (part instanceof Uint8Array) return part;
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (part && typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  throw new Error('分片数据无法读取');
}
