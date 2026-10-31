/**
 * Offscreen document：HLS 分片下载 / AES-128 解密 / ffmpeg.wasm 转封装。
 *
 * 并发模型（早期版本这里是全局单任务锁，多标签页同时下载会被直接拒绝）：
 * - 下载 + 解密：按任务并行，最多 MAX_JOBS 个任务，每个任务内部再开 CONCURRENCY 路请求。
 * - 转封装：ffmpeg.wasm 是单实例、单线程、吃内存，所以走一条互斥队列串行执行。
 *   整体即「并行下载 → 排队封装」，而不是简单地把并发全打开。
 * - 每个任务持有独立的取消令牌 / AbortController / AES key 缓存 / 进度节流，
 *   任务之间互不干扰。
 */

import { parsePlaylist, ivFromHex, ivFromSequence } from './lib/m3u8.js';
import { sanitizeName, hostOf } from './lib/media.js';

const LIMIT_MP4_BYTES = 900 * 1024 * 1024; // 单个任务走 MP4 转封装的安全上限
const LIMIT_TOTAL_BYTES = 1600 * 1024 * 1024; // 所有任务同时驻留内存的上限
const CONCURRENCY = 6; // 单个任务内部的分片并发数
const MAX_JOBS = 3; // 同时进行的任务数上限
const PROGRESS_THROTTLE = 250;

/** jobId -> ctx。ctx 承载该任务的全部可变状态，替代原来的全局 current。 */
const jobs = new Map();

let ffmpegInstance = null;
let ffmpegLoading = null;
let muxChain = Promise.resolve(); // 转封装互斥队列
let muxBusy = false;
let totalHeld = 0; // 所有任务已下载分片的字节数之和

// ---------------------------------------------------------------------------
// 任务上下文
// ---------------------------------------------------------------------------

function makeCtx(jobId) {
  const controller = new AbortController();
  return {
    jobId,
    cancelled: false,
    controller,
    signal: controller.signal,
    keyCache: new Map(),
    lastProgressAt: 0,
    held: 0
  };
}

/** 计入全局内存预算；超了就让这个任务失败，而不是把浏览器拖挂 */
function holdBytes(ctx, n) {
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

function releaseHeld(ctx) {
  if (!ctx.held) return;
  totalHeld = Math.max(0, totalHeld - ctx.held);
  ctx.held = 0;
}

// ---------------------------------------------------------------------------
// 与 Service Worker 通信
// ---------------------------------------------------------------------------

function report(payload) {
  return chrome.runtime.sendMessage({ target: 'sw', ...payload }).catch(() => null);
}

const stage = (ctx, text) => report({ type: 'JOB_STAGE', jobId: ctx.jobId, stage: text });

/** 进度节流按任务计时，避免一个任务的进度把另一个任务的进度吞掉 */
function progress(ctx, ratio, text, extra = {}) {
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

// ---------------------------------------------------------------------------
// 网络工具
// ---------------------------------------------------------------------------

/**
 * 按域名限流。
 *
 * Chrome 对同一个主机（HTTP/1.1）只开 6 条 TCP 连接。多任务并发时如果每个任务
 * 各自开 6 路，3 个任务就是 18 个请求抢 6 条连接：队头阻塞、连接反复抢占，
 * 聚合吞吐反而比单任务更差（实测表现就是「三个一起下巨慢」）。
 *
 * 所以把并发预算按域名全局分配：同一域名同时在途的请求永远不超过 6 个，
 * 多个任务按 FIFO 公平排队。单任务时仍然是 6 路，速度不受影响。
 */
const HOST_INFLIGHT = 6;
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
async function fetchBytes(ctx, url, range, asText = false, gated = false) {
  const headers = {};
  if (range && Number.isFinite(range.length)) {
    const start = Number.isFinite(range.offset) ? range.offset : 0;
    headers.Range = `bytes=${start}-${start + range.length - 1}`;
  }

  const release = gated ? await acquireSlot(url, ctx.signal) : null;
  try {
    const res = await fetch(url, { headers, credentials: 'include', signal: ctx.signal });
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

const fetchText = (ctx, url) => fetchBytes(ctx, url, null, true);

async function pool(total, limit, worker, ctx) {
  let next = 0;
  const size = Math.max(1, Math.min(limit || CONCURRENCY, total));
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

// ---------------------------------------------------------------------------
// 分片下载 + 解密
// ---------------------------------------------------------------------------

async function decryptSegment(ctx, data, key, seq) {
  let cryptoKey = ctx.keyCache.get(key.url);
  if (!cryptoKey) {
    const raw = await fetchBytes(ctx, key.url);
    cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    ctx.keyCache.set(key.url, cryptoKey);
  }
  const iv = key.iv ? ivFromHex(key.iv) : ivFromSequence(seq);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return new Uint8Array(plain);
}

function concatParts(parts) {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function sumParts(parts) {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  return len;
}

/**
 * 把两路 TS 分片按段交错。
 * 视频和音频是两条独立的播放列表，直接"视频全拼完再拼音频"会让声音全部跑到片尾，
 * 按段交错才能让播放器边读边同步。
 */
function interleaveParts(videoParts, audioParts) {
  const out = [];
  const n = Math.max(videoParts.length, audioParts.length);
  for (let i = 0; i < n; i += 1) {
    if (videoParts[i]) out.push(videoParts[i]);
    if (audioParts[i]) out.push(audioParts[i]);
  }
  return out;
}

/**
 * 下载一个 media playlist 的全部分片。
 * @returns {{parts: Uint8Array[], isFmp4: boolean, count: number, duration: number}}
 */
async function downloadPlaylistParts(ctx, playlistUrl, label, onTick) {
  const text = await fetchText(ctx, playlistUrl);
  const pl = parsePlaylist(text, playlistUrl);

  if (pl.type !== 'media') throw new Error(`${label} 不是媒体播放列表`);
  if (!pl.segments.length) throw new Error(`${label} 没有分片`);
  if (!pl.endList) throw new Error(`${label} 是直播流（未出现 EXT-X-ENDLIST），暂不支持`);
  if (pl.encrypted && pl.keyMethod && !/^AES-128$/i.test(pl.keyMethod)) {
    throw new Error(`${label} 使用了不支持的加密方式：${pl.keyMethod}`);
  }

  const total = pl.segments.length;
  const out = new Array(total);
  let done = 0;

  await pool(
    total,
    CONCURRENCY,
    async (i) => {
      const seg = pl.segments[i];
      // 只有分片占域名并发名额，且名额在 fetch 结束后立刻释放，
      // 后面的解密 / 取密钥都不会带着名额等待
      let data = await fetchBytes(ctx, seg.url, seg.byteRange, false, true);
      if (seg.key && seg.key.method === 'AES-128' && seg.key.url) {
        try {
          data = await decryptSegment(ctx, data, seg.key, seg.seq);
        } catch (e) {
          const detail = String(e && e.message ? e.message : e);
          throw new Error(`第 ${i + 1}/${total} 个分片解密失败（AES-128）：${detail}`);
        }
      }
      out[i] = data;
      done += 1;
      if (onTick) onTick(done, total);
    },
    ctx
  );

  const parts = [];
  // fMP4 的初始化段必须排在最前面，否则解不出来
  if (pl.map && pl.map.url) parts.push(await fetchBytes(ctx, pl.map.url));
  for (const chunk of out) {
    if (chunk) parts.push(chunk);
  }

  return { parts, isFmp4: pl.isFmp4, count: total, duration: pl.totalDuration };
}

// ---------------------------------------------------------------------------
// ffmpeg.wasm
// ---------------------------------------------------------------------------

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;

  ffmpegLoading = (async () => {
    const Ctor = globalThis.FFmpegWASM && globalThis.FFmpegWASM.FFmpeg;
    if (!Ctor) throw new Error('ffmpeg.wasm 未加载，请确认 vendor/ffmpeg/ 目录文件完整');

    const ff = new Ctor();
    ff.on('log', () => {});
    await ff.load({
      coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm')
    });
    ffmpegInstance = ff;
    return ff;
  })().finally(() => {
    ffmpegLoading = null;
  });

  return ffmpegLoading;
}

/**
 * 转封装互斥队列。
 * ffmpeg.wasm 只有一个实例，并发 exec 会互相读写同一份虚拟文件系统，
 * 所以这里串行化；队列前的失败不能卡住后面的任务，因此两个 then 回调都传 task。
 */
function enqueueMux(task) {
  const run = muxChain.then(task, task);
  muxChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function safeDelete(ff, name) {
  try {
    await ff.deleteFile(name);
  } catch {
    /* 文件不存在，忽略 */
  }
}

/**
 * 转封装成 MP4（-c copy，不重新编码）。
 * TS 源里的 AAC 需要 aac_adtstoasc 位流滤镜，非 AAC 源加了会报错 —— 所以失败自动重试一次。
 * 文件名带 jobId：即使将来放开并发，也不会互相覆盖。
 */
async function muxToMp4(ctx, videoBytes, audioBytes) {
  const tag = String(ctx.jobId || 'job').replace(/[^\w-]/g, '').slice(-10) || 'job';
  const vName = `v_${tag}.bin`;
  const aName = `a_${tag}.bin`;
  const outName = `o_${tag}.mp4`;

  const ff = await getFFmpeg();

  await safeDelete(ff, outName);
  await ff.writeFile(vName, videoBytes);
  if (audioBytes) await ff.writeFile(aName, audioBytes);

  const build = (withBsf) => {
    const args = ['-i', vName];
    if (audioBytes) args.push('-i', aName);
    args.push('-c', 'copy');
    if (audioBytes) args.push('-map', '0:v:0', '-map', '1:a:0');
    if (withBsf) args.push('-bsf:a', 'aac_adtstoasc');
    args.push('-movflags', '+faststart', '-y', outName);
    return args;
  };

  try {
    let rc = await ff.exec(build(true));
    if (rc !== 0) {
      await stage(ctx, '首次封装失败，改用兼容模式重试');
      await safeDelete(ff, outName);
      rc = await ff.exec(build(false));
    }
    if (rc !== 0) throw new Error('ffmpeg 转封装失败，可能是不支持的编码格式');

    const data = await ff.readFile(outName);
    return new Uint8Array(data);
  } finally {
    await safeDelete(ff, vName);
    await safeDelete(ff, aName);
    await safeDelete(ff, outName);
  }
}

// ---------------------------------------------------------------------------
// 任务主流程
// ---------------------------------------------------------------------------

function buildFilename(job, ext) {
  const host = sanitizeName(job.host || hostOf(job.pageUrl) || 'video', 'site');
  const base = sanitizeName(job.title || host, 'video');
  return `视频嗅探/${host}/${base}-${job.id.slice(-5)}.${ext}`;
}

function assertLive(ctx) {
  if (ctx.cancelled) throw new Error('已取消');
}

async function runJob(job, ctx) {
  // 1) 解析播放列表
  await progress(ctx, 0.02, '解析播放列表');

  let playlistUrl = job.variantUrl || job.url;
  const text = await fetchText(ctx, playlistUrl);
  const pl = parsePlaylist(text, playlistUrl);

  // 走的是 master：挑清晰度，并把它挂的独立音轨地址一并取出来
  if (pl.type === 'master') {
    const pick =
      pl.variants.find((v) => v.url === job.variantUrl) ||
      pl.variants.find((v) => v.url === job.url) ||
      pl.variants[0];
    if (!pick) throw new Error('主播放列表里没有可用清晰度');
    playlistUrl = pick.url;
    if (!job.audioUrl) job.audioUrl = pick.audioUrl || '';
  }

  assertLive(ctx);

  // 2) 视频轨
  const video = await downloadPlaylistParts(ctx, playlistUrl, '视频轨', (d, t) => {
    void progress(ctx, 0.05 + (d / t) * 0.7, `下载分片 ${d}/${t}`, { received: d, total: t });
  });

  assertLive(ctx);

  // 3) 独立音轨（master 用 EXT-X-MEDIA 分离音频时才会有）
  let audio = null;
  if (job.audioUrl && job.audioUrl !== playlistUrl) {
    await stage(ctx, '下载音轨分片');
    audio = await downloadPlaylistParts(ctx, job.audioUrl, '音频轨', (d, t) => {
      void progress(ctx, 0.75 + (d / t) * 0.15, `下载音轨 ${d}/${t}`, { received: d, total: t });
    });
  }

  assertLive(ctx);

  const ext = job.output === 'ts' && !video.isFmp4 ? 'ts' : 'mp4';

  // 4) 输出
  let blob;
  if (ext === 'ts') {
    // 不做 concat：拼接成一整块连续内存会让峰值翻倍，多任务并发时直接触发 GC 抖动。
    // 直接把分片数组交给 Blob，Chrome 会把大 Blob 落到磁盘，峰值内存从 2 倍降到 1 倍。
    // 有独立音轨时按段交错，保证声画同步。
    await progress(ctx, 0.93, '拼接 TS');
    const parts = audio ? interleaveParts(video.parts, audio.parts) : video.parts;
    blob = new Blob(parts, { type: 'video/mp2t' });
  } else {
    const videoBytes = concatParts(video.parts);
    const audioBytes = audio ? concatParts(audio.parts) : null;
    const sumBytes = videoBytes.byteLength + (audioBytes ? audioBytes.byteLength : 0);

    // 记账：把已下载的分片计入全局内存预算
    holdBytes(ctx, sumParts(video.parts) + (audio ? sumParts(audio.parts) : 0));

    if (sumBytes > LIMIT_MP4_BYTES) {
      throw new Error(
        `分片总大小约 ${(sumBytes / 1024 / 1024).toFixed(0)}MB，超过浏览器内转封装的安全上限。` +
          '请改用「TS 直出」格式下载，再用本机播放器/VLC 处理。'
      );
    }
    await progress(ctx, 0.9, '加载 ffmpeg 引擎');
    await getFFmpeg();
    if (muxBusy) await stage(ctx, '排队等待转封装（引擎被其他任务占用）');
    await progress(ctx, 0.94, '转封装为 MP4');
    const mp4 = await enqueueMux(async () => {
      muxBusy = true;
      try {
        assertLive(ctx);
        return await muxToMp4(ctx, videoBytes, audioBytes);
      } finally {
        muxBusy = false;
      }
    });
    blob = new Blob([mp4], { type: 'video/mp4' });
  }

  assertLive(ctx);
  await progress(ctx, 0.99, '生成下载文件');

  const blobUrl = URL.createObjectURL(blob);

  await report({
    type: 'JOB_READY',
    jobId: ctx.jobId,
    blobUrl,
    filename: buildFilename(job, ext),
    mime: blob.type,
    size: blob.size
  });
}

// ---------------------------------------------------------------------------
// 引擎自检
// ---------------------------------------------------------------------------

/**
 * 确认 ffmpeg.wasm 真的能在扩展里加载并执行。
 * 会现场用 lavfi 生成一段真实的 TS，再走一遍生产用的 muxToMp4，
 * 因此一次覆盖：wasm 加载 / Worker / CSP / 编码器可用性 / mux 参数正确性。
 */
async function engineSelfTest() {
  const ff = await getFFmpeg();
  const logs = [];
  const onLog = ({ message }) => {
    logs.push(message);
    if (logs.length > 80) logs.shift();
  };
  ff.on('log', onLog);

  let rcVersion = -1;
  let rcGen = -1;
  let genSize = 0;
  let rcMux = null;
  let mp4Size = 0;
  let muxError = '';

  try {
    rcVersion = await ff.exec(['-version']);

    const genName = 'selftest-src.ts';
    await safeDelete(ff, genName);
    rcGen = await ff.exec([
      '-f', 'lavfi', '-i', 'testsrc=size=128x72:rate=10:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', '-y', genName
    ]);

    if (rcGen === 0) {
      const gen = await ff.readFile(genName);
      genSize = gen.byteLength;
      try {
        const ctx = { jobId: 'selftest', cancelled: false };
        const mp4 = await enqueueMux(() => muxToMp4(ctx, new Uint8Array(gen), null));
        rcMux = 0;
        mp4Size = mp4.byteLength;
      } catch (e) {
        rcMux = -1;
        muxError = String(e && e.message ? e.message : e);
      }
      await safeDelete(ff, genName);
    }
  } finally {
    try {
      ff.off('log', onLog);
    } catch {
      /* 忽略 */
    }
  }

  return { rcVersion, rcGen, genSize, rcMux, mp4Size, muxError, log: logs.slice(-10).join('\n') };
}

// ---------------------------------------------------------------------------
// 消息入口
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return undefined;

  if (msg.type === 'ENGINE_SELFTEST') {
    // 结果必须经 SW 回传：SW 可能已休眠，这条消息会把它唤醒并落盘
    sendResponse({ ok: true, started: true });
    engineSelfTest()
      .then((r) => report({ type: 'SELFTEST_RESULT', result: { ok: r.rcGen === 0 && r.rcMux === 0, ...r } }))
      .catch((e) =>
        report({
          type: 'SELFTEST_RESULT',
          result: { ok: false, error: String(e && e.message ? e.message : e) }
        })
      );
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

    const ctx = makeCtx(jobId);
    jobs.set(jobId, ctx);
    sendResponse({ ok: true });

    runJob(msg.job, ctx)
      .catch(async (e) => {
        // 主动取消不算失败：background 已经把状态改成「已取消」
        if (ctx.cancelled) return;
        const message = String(e && e.message ? e.message : e);
        await report({ type: 'JOB_ERROR', jobId, message });
      })
      .finally(() => {
        releaseHeld(ctx);
        jobs.delete(jobId);
      });
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
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});
