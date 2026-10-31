/**
 * 分片落盘（OPFS）：断点续传的载体，同时把「全部分片驻留内存」改成「边下边写盘」。
 *
 * 目录结构（每个视频一个目录，用 downloadKey 命名）：
 *   /vd-segments/<key>/store.json   { key, createdAt, touched }
 *   /vd-segments/<key>/v-meta.json  视频轨元信息 { count, isFmp4, mapUrl }
 *   /vd-segments/<key>/a-meta.json  音频轨元信息
 *   /vd-segments/<key>/v-000001.bin 视频分片（1 基序号）
 *   /vd-segments/<key>/a-000001.bin 音频分片
 *   /vd-segments/<key>/v-init.bin   fMP4 初始化段
 *
 * 为什么不用 IndexedDB：1500 个几 MB 的 Blob 在 IDB 里读写会反复结构化克隆，
 * 内存峰值和耗时都不可控；OPFS 是文件句柄 + 流式写入，还能直接把 File 交给 Blob
 * 组装，避免二次拷贝。
 *
 * 浏览器不支持 OPFS 时（或被策略禁用）所有函数返回 null / no-op，调用方自动退回
 * 「全内存」的老路径，功能不受影响，只是没有续传能力。
 */

const ROOT_NAME = 'vd-segments';
const STORE_META = 'store.json';
const MAX_STORES = 8; // 最多保留几个未完成任务的分片目录
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 超过 7 天未动过的分片清掉

let rootPromise = null;

function root() {
  if (!rootPromise) {
    rootPromise = (async () => {
      try {
        if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
        return await navigator.storage.getDirectory();
      } catch {
        return null;
      }
    })();
  }
  return rootPromise;
}

async function readJson(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writeJson(dir, name, value) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(JSON.stringify(value));
  } finally {
    await w.close();
  }
}

export const segNameOf = (prefix, index) => `${prefix}-${String(index + 1).padStart(6, '0')}.bin`;
export const initNameOf = (prefix) => `${prefix}-init.bin`;

class SegStore {
  constructor(dir, key) {
    this.dir = dir;
    this.key = key;
    /** 会话内已知存在的分片序号，避免每次都去问文件系统 */
    this.known = null;
  }

  async put(name, bytes) {
    const fh = await this.dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(bytes);
    } finally {
      await w.close();
    }
  }

  async get(name) {
    try {
      const fh = await this.dir.getFileHandle(name);
      return await fh.getFile();
    } catch {
      return null;
    }
  }

  async has(name) {
    return (await this.get(name)) !== null;
  }

  async read(name) {
    const file = await this.get(name);
    return file ? new Uint8Array(await file.arrayBuffer()) : null;
  }

  async list() {
    const names = [];
    try {
      for await (const [name, handle] of this.dir.entries()) {
        if (handle.kind === 'file') names.push(name);
      }
    } catch {
      /* 目录被外部删掉，当作空 */
    }
    return names;
  }

  /** 某一轨已下载的分片序号（0 基），按需从目录枚举一次 */
  async doneIndices(prefix) {
    if (!this.known) this.known = { v: null, a: null };
    if (this.known[prefix]) return this.known[prefix];

    const set = new Set();
    const re = new RegExp(`^${prefix}-(\\d{6})\\.bin$`);
    for (const name of await this.list()) {
      const m = re.exec(name);
      if (m) set.add(Number(m[1]) - 1);
    }
    this.known[prefix] = set;
    return set;
  }

  markDone(prefix, index) {
    if (this.known && this.known[prefix]) this.known[prefix].add(index);
  }

  async bytesOf(prefix) {
    let sum = 0;
    const re = new RegExp(`^${prefix}-(\\d{6}|init)\\.bin$`);
    for (const name of await this.list()) {
      if (!re.test(name)) continue;
      const file = await this.get(name);
      if (file) sum += file.size;
    }
    return sum;
  }

  async clearTrack(prefix) {
    const re = new RegExp(`^${prefix}-(\\d{6}|init)\\.bin$`);
    for (const name of await this.list()) {
      if (re.test(name)) await this.remove(name);
    }
    if (this.known) this.known[prefix] = new Set();
  }

  async remove(name) {
    try {
      await this.dir.removeEntry(name);
    } catch {
      /* 已被删，忽略 */
    }
  }

  async readMeta(prefix) {
    return readJson(this.dir, `${prefix}-meta.json`);
  }

  async writeMeta(prefix, meta) {
    return writeJson(this.dir, `${prefix}-meta.json`, meta);
  }
}

/**
 * 打开（或创建）某个视频的分片目录。
 * @returns {Promise<SegStore|null>} 不支持 OPFS 时为 null
 */
export async function openStore(key) {
  if (!key) return null;
  const r = await root();
  if (!r) return null;

  let dir;
  try {
    const base = await r.getDirectoryHandle(ROOT_NAME, { create: true });
    dir = await base.getDirectoryHandle(key, { create: true });
  } catch {
    return null;
  }

  const now = Date.now();
  const meta = (await readJson(dir, STORE_META)) || { key, createdAt: now };
  meta.touched = now;
  try {
    await writeJson(dir, STORE_META, meta);
  } catch {
    /* 元信息写不了不影响下载 */
  }
  return new SegStore(dir, key);
}

/** 下载任务彻底完成后清掉分片目录 */
export async function dropStore(key) {
  if (!key) return false;
  const r = await root();
  if (!r) return false;
  try {
    const base = await r.getDirectoryHandle(ROOT_NAME);
    await base.removeEntry(key, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理过期 / 超量的分片目录。
 * 只清「不在本次活动任务里」的目录，正在续传的数据不会被误删。
 */
export async function pruneStores(activeKeys = new Set()) {
  const r = await root();
  if (!r) return 0;

  let base;
  try {
    base = await r.getDirectoryHandle(ROOT_NAME);
  } catch {
    return 0;
  }

  const now = Date.now();
  const entries = [];
  for await (const [name, handle] of base.entries()) {
    if (handle.kind !== 'directory') continue;
    const meta = await readJson(handle, STORE_META);
    entries.push({ name, touched: (meta && meta.touched) || 0 });
  }

  entries.sort((a, b) => b.touched - a.touched);
  let removed = 0;
  const survivors = [];
  for (const entry of entries) {
    if (activeKeys.has(entry.name)) {
      survivors.push(entry);
      continue;
    }
    if (now - entry.touched > MAX_AGE_MS) {
      try {
        await base.removeEntry(entry.name, { recursive: true });
        removed += 1;
      } catch {
        /* 忽略 */
      }
      continue;
    }
    survivors.push(entry);
  }

  // 仍然超量就按最久未用淘汰
  for (const entry of survivors.slice(MAX_STORES)) {
    if (activeKeys.has(entry.name)) continue;
    try {
      await base.removeEntry(entry.name, { recursive: true });
      removed += 1;
    } catch {
      /* 忽略 */
    }
  }

  return removed;
}

/** 磁盘占用（只统计分片目录，用于提示用户） */
export async function usage() {
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}
