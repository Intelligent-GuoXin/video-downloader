/**
 * Offscreen document 的创建与通信。
 *
 * 下载 / 合流这类长任务必须放 offscreen document（SW 无 DOM、30s 空闲即死）。
 * 创建有并发坑：两次并发 createDocument 会抛 "Only a single offscreen..."，
 * 所以用模块级的 promise 去重。
 */

const OFFSCREEN_URL = 'offscreen.html';

let offscreenCreating = null;

async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS', 'WORKERS'],
        justification: '在本地下载媒体分片并转封装为可播放的文件'
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  return offscreenCreating;
}

/** 发给 offscreen 的消息，失败（未就绪 / 已销毁）返回 null，不打断调用方 */
export function toOffscreen(payload) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload }).catch(() => null);
}

/** 发给 popup 的消息，popup 没开着就静默丢弃 */
export function toPopup(payload) {
  return chrome.runtime.sendMessage({ target: 'popup', ...payload }).catch(() => null);
}
