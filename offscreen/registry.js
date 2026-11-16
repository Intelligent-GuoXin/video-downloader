/**
 * 全局任务登记表：活跃任务的 downloadKey 集合 + blob 产物登记。
 *
 * 用途：① 新任务开分片目录前，把「不属于任何活跃任务」的旧目录清掉（pruneStores）；
 *       ② 消息层做「同一视频不能并发两个任务」的去重判断；
 *       ③ blob URL -> OPFS 输出文件的映射，下载落盘后据此清理副本。
 * 放在独立模块里，消息层（offscreen.js）与任务层（jobs/*）都能读写而不互相依赖。
 */

const activeKeys = new Set(); // 活跃任务的 downloadKey

export function addActiveKey(key) {
  if (key) activeKeys.add(key);
}

export function removeActiveKey(key) {
  if (key) activeKeys.delete(key);
}

export function hasActiveKey(key) {
  return Boolean(key) && activeKeys.has(key);
}

export function activeKeyList() {
  return [...activeKeys];
}

/** blobUrl -> { key, ext }：产物在 OPFS 里的副本，下载完成后清理 */
const blobOutputs = new Map();

export function registerBlobOutput(blobUrl, key, ext = 'mp4') {
  if (blobUrl && key) blobOutputs.set(blobUrl, { key, ext });
}

/** 取走登记（并删除映射）；调用方负责 dropOutputFile */
export function takeBlobOutput(blobUrl) {
  const entry = blobOutputs.get(blobUrl);
  if (entry) blobOutputs.delete(blobUrl);
  return entry || null;
}
