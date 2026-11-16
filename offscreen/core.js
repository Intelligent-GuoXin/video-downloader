/**
 * Offscreen 任务的公共底座：任务上下文、进度上报、内存预算、常量。
 *
 * 只依赖 chrome.runtime，不碰网络与磁盘，被 jobs/* 与 offscreen.js 共用。
 */

/** 进度上报节流间隔（ms） */
export const PROGRESS_THROTTLE = 250;
/** 单任务内部的分片并发数（HTTP/2 下多流才吃得满带宽） */
export const CONCURRENCY = 8;
/** 同时进行的任务数上限 */
export const MAX_JOBS = 3;
/** 所有任务同时驻留内存的上限（兜底路径整块读内存时用） */
export const LIMIT_TOTAL_BYTES = 1600 * 1024 * 1024;

/**
 * jobId -> ctx。ctx 承载该任务的全部可变状态（取消令牌 / AES key 缓存 /
 * 进度节流时间戳 / 分片落盘句柄），任务之间互不干扰。
 */
export function makeCtx(jobId) {
  const controller = new AbortController();
  return {
    jobId,
    cancelled: false,
    controller,
    signal: controller.signal,
    keyCache: new Map(),
    lastProgressAt: 0,
    held: 0,
    /** 分片落盘句柄（OPFS 不可用时为 null，退回全内存） */
    store: null,
    /** 续传身份：同一个视频每次点下载都应该算出同样的值 */
    downloadKey: ''
  };
}

/** 发给 Service Worker 的消息，失败（SW 休眠唤醒间隙）静默返回 null */
export function report(payload) {
  return chrome.runtime.sendMessage({ target: 'sw', ...payload }).catch(() => null);
}

export const stage = (ctx, text) => report({ type: 'JOB_STAGE', jobId: ctx.jobId, stage: text });

/** 进度节流按任务计时，避免一个任务的进度把另一个任务的进度吞掉 */
export function progress(ctx, ratio, text, extra = {}) {
  const now = Date.now();
  if (ratio < 1 && now - ctx.lastProgressAt < PROGRESS_THROTTLE) return Promise.resolve(null);
  ctx.lastProgressAt = now;
  return report({
    type: 'JOB_PROGRESS',
    jobId: ctx.jobId,
    stage: text,
    progress: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    ...extra
  });
}

/** 任务已被取消时抛错，让长循环尽快退出 */
export function assertLive(ctx) {
  if (ctx.cancelled) throw new Error('已取消');
}

export const errorText = (e) => String(e && e.message ? e.message : e);

// ---------------------------------------------------------------------------
// 全局内存预算（只有「整块读进内存」的兜底路径需要；主流式路径不受影响）
// ---------------------------------------------------------------------------

let totalHeld = 0;

/** 计入全局内存预算；超了就让这个任务失败，而不是把浏览器拖挂 */
export function holdBytes(ctx, n) {
  if (!n) return;
  ctx.held += n;
  totalHeld += n;
  if (totalHeld > LIMIT_TOTAL_BYTES) {
    throw new Error(
      `同时下载的内容已占用约 ${(totalHeld / 1024 / 1024).toFixed(0)}MB 内存，超过安全上限。` +
        '请等当前任务完成后再开始新的下载。'
    );
  }
}

export function releaseHeld(ctx) {
  if (!ctx.held) return;
  totalHeld = Math.max(0, totalHeld - ctx.held);
  ctx.held = 0;
}
