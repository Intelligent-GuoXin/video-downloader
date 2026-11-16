/**
 * Offscreen document 入口：消息路由 + 任务调度。
 *
 * 重活都在 jobs/ 里：
 * - jobs/hls.js —— HLS 分片下载、AES-128 解密、流式重封装；
 * - jobs/direct.js —— 直链抓取、音视频分离合并、fMP4 转换。
 *
 * 并发模型：
 * - 下载 + 解密：按任务并行，最多 MAX_JOBS 个任务，每个任务内部再开多路请求
 *   （见 lib/transport.js 的域名限流）。
 * - 每个任务持有独立的取消令牌 / AbortController / AES key 缓存 / 进度节流，
 *   任务之间互不干扰。
 */

import { makeCtx, releaseHeld, report, MAX_JOBS } from './offscreen/core.js';
import { removeActiveKey, addActiveKey, hasActiveKey, takeBlobOutput } from './offscreen/registry.js';
import { dropStore } from './lib/segstore.js';
import { dropOutputFile } from './lib/outputsink.js';
import { resumeKeyOf } from './lib/media.js';
import { runHlsJob } from './jobs/hls.js';
import { runDirectJob, probeUrl } from './jobs/direct.js';

/** jobId -> ctx */
const jobs = new Map();

// ---------------------------------------------------------------------------
// 消息入口
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return undefined;

  if (msg.type === 'PROBE_URL') {
    probeUrl(msg.url).then((r) => sendResponse(r));
    return true;
  }

  if (msg.type === 'JOB_START') {
    const jobId = msg.job && msg.job.id;
    if (!jobId) {
      sendResponse({ ok: false, error: '任务缺少 id' });
      return true;
    }
    if (jobs.has(jobId)) {
      sendResponse({ ok: false, error: '该任务已在运行' });
      return true;
    }
    if (jobs.size >= MAX_JOBS) {
      sendResponse({
        ok: false,
        error: `同时下载任务已达上限（${MAX_JOBS} 个），请等待其他任务完成`
      });
      return true;
    }

    const isDirect = msg.job.type === 'direct';

    // 同一个视频不能有两个任务同时写同一份分片目录，否则会互相覆盖
    const key = isDirect ? '' : msg.job.downloadKey || resumeKeyOf(msg.job.variantUrl || msg.job.url);
    if (key && hasActiveKey(key)) {
      sendResponse({ ok: false, error: '这个视频已经在下载中，请等它结束或先取消' });
      return true;
    }

    const ctx = makeCtx(jobId);
    ctx.downloadKey = key;
    // 立刻登记续传身份：去重判断在任务真正打开分片目录之前就要生效，
    // 否则两个同视频任务可能同时写同一份分片目录
    if (key) addActiveKey(key);
    jobs.set(jobId, ctx);
    sendResponse({ ok: true });

    const runner = isDirect ? runDirectJob : runHlsJob;
    runner(msg.job, ctx)
      .catch(async (e) => {
        // 主动取消不算失败：background 已经把状态改成「已取消」
        if (ctx.cancelled) return;
        let message = String(e && e.message ? e.message : e);
        // 失败时已经下到的分片留在盘上，重新点下载可以接着下
        if (ctx.store) message += '（已下载的分片已保留，重新点击下载会从断点继续）';
        await report({ type: 'JOB_ERROR', jobId, message });
      })
      .finally(() => {
        releaseHeld(ctx);
        removeActiveKey(key);
        jobs.delete(jobId);
      });
    return true;
  }

  if (msg.type === 'PURGE_JOB') {
    // 只有文件真正落到用户磁盘后才清分片目录，否则 blob 可能还没被读完
    dropStore(msg.downloadKey || '')
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'JOB_CANCEL') {
    const ctx = jobs.get(msg.jobId);
    if (ctx) {
      ctx.cancelled = true;
      // 中断在途请求，取消能立刻生效，不用等当前分片下完
      try {
        ctx.controller.abort();
      } catch {
        /* 忽略 */
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RELEASE_BLOB') {
    try {
      URL.revokeObjectURL(msg.blobUrl);
    } catch {
      /* 忽略 */
    }
    // 下载已经落地，重封装产物的 OPFS 副本没有保留价值，顺手删掉省空间
    const entry = takeBlobOutput(msg.blobUrl);
    if (entry) void dropOutputFile(entry.key, entry.ext);
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});
