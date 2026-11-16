/**
 * 网络传输层：域名并发限流、可取消 fetch、分片重试、并发池。
 *
 * 为什么按域名限流：Chrome 对同一主机（HTTP/1.1）只开 6 条 TCP 连接。
 * 多任务并发时如果每个任务各开 6 路，3 个任务就是 18 个请求抢 6 条连接：
 * 队头阻塞、连接反复抢占，聚合吞吐反而比单任务更差。
 * 所以把并发预算按域名全局分配：同一域名同时在途的请求数有上限，
 * 多个任务按 FIFO 公平排队。HTTP/1.1 站点多出来的请求只是排在 socket 池里等待；
 * HTTP/2 站点一条连接能跑多条流，开大一点才能真正吃满带宽。
 */

import { assertLive } from '../offscreen/core.js';

const HOST_INFLIGHT = 8;
const SEG_ATTEMPTS = 4; // 单个分片的最大尝试次数

const hostSlots = new Map(); // host -> { inflight, queue }

function hostKeyOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** @returns {Promise<() => void>} 释放函数 */
function acquireSlot(url, signal) {
  const key = hostKeyOf(url);
  if (!key) return Promise.resolve(() => {});

  let slot = hostSlots.get(key);
  if (!slot) {
    slot = { inflight: 0, queue: [] };
    hostSlots.set(key, slot);
  }

  if (slot.inflight < HOST_INFLIGHT) {
    slot.inflight += 1;
    return Promise.resolve(() => releaseSlot(key));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = slot.queue.indexOf(grant);
      if (i >= 0) slot.queue.splice(i, 1);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error('已取消'));
    };
    const grant = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(() => releaseSlot(key));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    slot.queue.push(grant);
  });
}

function releaseSlot(key) {
  const slot = hostSlots.get(key);
  if (!slot) return;
  const next = slot.queue.shift();
  if (next) {
    // 名额直接转交给队首，inflight 不变
    next();
    return;
  }
  slot.inflight -= 1;
  if (slot.inflight <= 0) hostSlots.delete(key);
}

/**
 * @param gated 是否占用域名并发名额。只有分片这种大流量请求需要；
 *   播放列表 / 密钥 / init 段不占名额，避免「名额被 worker 占着、worker 又在等密钥」的死锁。
 */
export async function fetchBytes(ctx, url, range, asText = false, gated = false) {
  const headers = {};
  if (range && Number.isFinite(range.length)) {
    const start = Number.isFinite(range.offset) ? range.offset : 0;
    headers.Range = `bytes=${start}-${start + range.length - 1}`;
  }

  const init = { headers, credentials: 'include', signal: ctx.signal };
  // 隐藏页面的请求默认被标成最低优先级，Chromium 会给这类请求更少的连接配额，
  // 这是「单个下载也很慢」的一个来源。分片请求显式抬到 high。
  if (gated) init.priority = 'high';

  const release = gated ? await acquireSlot(url, ctx.signal) : null;
  try {
    const res = await fetch(url, init);
    if (!res.ok && res.status !== 206) {
      let tail = url;
      try {
        tail = new URL(url).pathname.slice(-40);
      } catch {
        /* 保持原样 */
      }
      throw new Error(`请求失败 ${res.status}：${tail}`);
    }
    if (asText) return await res.text();
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    if (release) release();
  }
}

export const fetchText = (ctx, url) => fetchBytes(ctx, url, null, true);

/** 可被取消中断的等待，用于重试退避 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('已取消'));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('已取消'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 单个分片下载，失败自动重试。
 * 以前一片 4xx/断流就把整个任务判死，1500 片的大视频几乎必然中途失败、
 * 而且失败后一切归零；现在只重试这一片，重试仍失败才让任务失败（分片已落盘，可续传）。
 */
export async function fetchSegment(ctx, seg, index, total) {
  let last = null;
  for (let attempt = 1; attempt <= SEG_ATTEMPTS; attempt += 1) {
    assertLive(ctx);
    try {
      return await fetchBytes(ctx, seg.url, seg.byteRange, false, true);
    } catch (e) {
      last = e;
      if (ctx.cancelled) throw e;
      if (attempt >= SEG_ATTEMPTS) break;
      // 400ms / 800ms / 1600ms + 抖动，避免多路同时重试又撞在一起
      await sleep(400 * 2 ** (attempt - 1) + Math.random() * 300, ctx.signal);
    }
  }
  const why = String(last && last.message ? last.message : last);
  throw new Error(`第 ${index + 1}/${total} 个分片下载失败（已重试 ${SEG_ATTEMPTS} 次）：${why}`);
}

/** 固定并发数的池：worker 从 0..total-1 领号执行，取消时全体退出 */
export async function pool(total, limit, worker, ctx) {
  let next = 0;
  const size = Math.max(1, Math.min(limit || 8, total));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      if (ctx.cancelled) return;
      const i = next;
      next += 1;
      if (i >= total) return;
      await worker(i);
    }
  });
  await Promise.all(runners);
}
