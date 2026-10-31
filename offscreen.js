/**
 * Offscreen document：HLS 分片下载 / AES-128 解密 / ffmpeg.wasm 转封装。
 *
 * 并发模型（早期版本这里是全局单任务锁，多标签页同时下载会被直接拒绝）：
 * - 下载 + 解密：按任务并行，最多 MAX_JOBS 个任务，每个任务内部再开 CONCURRENCY 路请求。
 * - 转封装：ffmpeg.wasm 是单实例、单线程、吃内存，所以走一条互斥队列串行执行。
 *   整体即「并行下载 → 排队封装」，而不是简单地把并发全打开。
 * - 每个任务持有独立的取消令牌 / AbortController / AES key 缓存 / 进度节流，
 *   任务之间互不干扰。
 *
 * 断点续传（0.3.0）：
 * - 分片下载完立刻写进 OPFS（见 lib/segstore.js），不再攒在内存里。
 * - 任务失败 / 取消 / 浏览器重启后，同一个视频重新点下载会跳过已下载的分片，
 *   从断点继续；只有播放列表片数变了才判定为「换了内容」，清掉重下。
 * - 单个分片失败不再直接判死整个任务：重试 SEG_ATTEMPTS 次（指数退避 + 抖动）。
 */

import { parsePlaylist, ivFromHex, ivFromSequence } from './lib/m3u8.js';
import { sanitizeName, hostOf, resumeKeyOf, pathKey } from './lib/media.js';
import { openStore, dropStore, pruneStores, segNameOf, initNameOf } from './lib/segstore.js';
import { TsDemuxer } from './lib/tsdemux.js';
import { Mp4Muxer } from './lib/mp4mux.js';

/**
 * ffmpeg.wasm 单次转封装的安全上限。
 * 新版本主力走 lib/mp4mux.js 的流式重封装（无上限），这个值只用于
 * 「流式重封装失败后是否还值得回退 ffmpeg」的判断。
 */
const LIMIT_MP4_BYTES = 900 * 1024 * 1024;
const LIMIT_TOTAL_BYTES = 1600 * 1024 * 1024; // 所有任务同时驻留内存的上限
const CONCURRENCY = 8; // 单个任务内部的分片并发数（HTTP/2 下多流才吃得满带宽）
const MAX_JOBS = 3; // 同时进行的任务数上限
const SEG_ATTEMPTS = 4; // 单个分片的最大尝试次数
const PROGRESS_THROTTLE = 250;

/** 重封装产物的落盘目录（与分片目录分开，避免被续传清理误删） */
const OUT_DIR = 'vd-out';

/** jobId -> ctx。ctx 承载该任务的全部可变状态，替代原来的全局 current。 */
const jobs = new Map();

let ffmpegInstance = null;
let ffmpegLoading = null;
let muxChain = Promise.resolve(); // 转封装互斥队列
let muxBusy = false;
let totalHeld = 0; // 所有任务已下载分片的字节数之和

/** blobUrl -> downloadKey，用来在下载完成后清掉对应的重封装产物 */
const blobOutputs = new Map();

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
    held: 0,
    /** 分片落盘句柄（OPFS 不可用时为 null，退回全内存） */
    store: null,
    /** 续传身份：同一个视频每次点下载都应该算出同样的值 */
    downloadKey: ''
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
 * 所以把并发预算按域名全局分配：同一域名同时在途的请求数有上限，
 * 多个任务按 FIFO 公平排队。HTTP/1.1 站点多出来的请求只是排在 socket 池里等待，
 * 不会比少开更慢；而 HTTP/2 站点一条连接能跑多条流，开大一点才能真正吃满带宽。
 */
const HOST_INFLIGHT = 8;
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

const fetchText = (ctx, url) => fetchBytes(ctx, url, null, true);

/** 可被取消中断的等待，用于重试退避 */
function sleep(ms, signal) {
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

const errorText = (e) => String(e && e.message ? e.message : e);

/**
 * 单个分片下载，失败自动重试。
 * 以前一片 4xx/断流就把整个任务判死，1500 片的大视频几乎必然中途失败、
 * 而且失败后一切归零；现在只重试这一片，重试仍失败才让任务失败（分片已落盘，可续传）。
 */
async function fetchSegment(ctx, seg, index, total) {
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
  throw new Error(`第 ${index + 1}/${total} 个分片下载失败（已重试 ${SEG_ATTEMPTS} 次）：${errorText(last)}`);
}

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

/** 把若干 Blob / Uint8Array 顺序拼成一块连续内存（只有 ffmpeg 转封装需要） */
async function joinToBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.size !== undefined ? p.size : p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    const chunk = p instanceof Blob ? new Uint8Array(await p.arrayBuffer()) : p;
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

/**
 * 把两路分片按段交错。
 * 视频和音频是两条独立的播放列表，直接"视频全拼完再拼音频"会让声音全部跑到片尾，
 * 按段交错才能让播放器边读边同步。
 */
function interleaveBlobs(videoParts, audioParts) {
  const out = [];
  const n = Math.max(videoParts.length, audioParts.length);
  for (let i = 0; i < n; i += 1) {
    if (videoParts[i]) out.push(videoParts[i]);
    if (audioParts[i]) out.push(audioParts[i]);
  }
  return out;
}

const sizeOf = (p) => (p && p.size !== undefined ? p.size : p ? p.byteLength : 0);
const sumSizes = (list) => list.reduce((n, p) => n + sizeOf(p), 0);

/**
 * 下载一个 media playlist 的全部分片，边下边落盘。
 *
 * 续传判定：分片以「序号文件名」存在 OPFS 里，开工前先看已经有哪些，
 * 有的直接跳过。只有播放列表片数或封装格式变了，才认为不是同一份内容、清掉重下。
 *
 * @returns {{
 *   store: object|null, prefix: string, count: number, isFmp4: boolean, hasMap: boolean,
 *   resumed: number, parts: (Uint8Array[]|null), mapBytes: (Uint8Array|null)
 * }}
 */
async function downloadTrack(ctx, playlistUrl, label, prefix, onTick) {
  const text = await fetchText(ctx, playlistUrl);
  const pl = parsePlaylist(text, playlistUrl);

  if (pl.type !== 'media') throw new Error(`${label} 不是媒体播放列表`);
  if (!pl.segments.length) throw new Error(`${label} 没有分片`);
  if (!pl.endList) throw new Error(`${label} 是直播流（未出现 EXT-X-ENDLIST），暂不支持`);
  if (pl.encrypted && pl.keyMethod && !/^AES-128$/i.test(pl.keyMethod)) {
    throw new Error(`${label} 使用了不支持的加密方式：${pl.keyMethod}`);
  }

  const total = pl.segments.length;
  const store = ctx.store;
  const mapUrl = (pl.map && pl.map.url) || '';
  const hasMap = Boolean(mapUrl);

  let resumedSet = new Set();
  if (store) {
    const playlistPath = pathKey(playlistUrl);
    const meta = await store.readMeta(prefix);
    // 片数、封装格式、播放列表路径任一变化，都说明不是同一份内容
    // （切清晰度时路径通常不同，token 变化则被 pathKey 抹掉，不会误判）
    if (
      meta &&
      (meta.count !== total ||
        Boolean(meta.isFmp4) !== Boolean(pl.isFmp4) ||
        (meta.playlistPath && meta.playlistPath !== playlistPath))
    ) {
      await store.clearTrack(prefix);
      await stage(ctx, `${label}：播放列表已变化，旧分片作废`);
    }
    await store.writeMeta(prefix, {
      count: total,
      isFmp4: pl.isFmp4,
      mapUrl,
      playlistPath,
      createdAt: Date.now()
    });
    resumedSet = await store.doneIndices(prefix);
  }

  const parts = store ? null : new Array(total);
  let done = 0;
  if (store && resumedSet.size) {
    for (const i of resumedSet) if (i >= 0 && i < total) done += 1;
    if (done) {
      await stage(ctx, `${label}：从断点继续，已有 ${done}/${total} 个分片`);
      if (onTick) onTick(done, total);
    }
  }
  const resumed = done;

  await pool(
    total,
    CONCURRENCY,
    async (i) => {
      if (store && resumedSet.has(i)) return;
      const seg = pl.segments[i];
      // 只有分片占域名并发名额，且名额在 fetch 结束后立刻释放，
      // 后面的解密 / 取密钥都不会带着名额等待
      let data = await fetchSegment(ctx, seg, i, total);
      if (seg.key && seg.key.method === 'AES-128' && seg.key.url) {
        try {
          data = await decryptSegment(ctx, data, seg.key, seg.seq);
        } catch (e) {
          throw new Error(`第 ${i + 1}/${total} 个分片解密失败（AES-128）：${errorText(e)}`);
        }
      }
      if (store) {
        await store.put(segNameOf(prefix, i), data);
        store.markDone(prefix, i);
      } else {
        parts[i] = data;
      }
      done += 1;
      if (onTick) onTick(done, total);
    },
    ctx
  );

  // fMP4 的初始化段必须排在最前面，否则解不出来
  let mapBytes = null;
  if (hasMap) {
    if (store) {
      const name = initNameOf(prefix);
      if (!(await store.has(name))) {
        await store.put(name, await fetchBytes(ctx, mapUrl));
      }
    } else {
      mapBytes = await fetchBytes(ctx, mapUrl);
    }
  }

  return { store, prefix, count: total, isFmp4: pl.isFmp4, hasMap, resumed, parts, mapBytes };
}

/**
 * 按顺序取出某一轨的全部分片。
 * OPFS 模式下拿到的是 File 对象，可以零拷贝交给 Blob；内存模式则返回 Uint8Array。
 */
async function orderedTrackParts(track) {
  const list = [];
  if (track.hasMap) {
    if (track.store) {
      const file = await track.store.get(initNameOf(track.prefix));
      if (file) list.push(file);
    } else if (track.mapBytes) {
      list.push(track.mapBytes);
    }
  }
  for (let i = 0; i < track.count; i += 1) {
    if (track.store) {
      const file = await track.store.get(segNameOf(track.prefix, i));
      if (!file) throw new Error(`分片不完整（第 ${i + 1}/${track.count} 个），重新点击下载即可续传`);
      list.push(file);
    } else {
      const part = track.parts[i];
      if (!part) throw new Error(`分片不完整（第 ${i + 1}/${track.count} 个），请重新下载`);
      list.push(part);
    }
  }
  return list;
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
// 流式重封装：TS → MP4（不重编码、无大小上限）
// ---------------------------------------------------------------------------

/**
 * 输出文件的落盘句柄。
 *
 * 和分片目录分开存：分片目录在任务完成后会被整个删掉，而输出文件要一直活到
 * 用户真正保存下载为止。写 mdat 时只是顺序 append，内存里不留下数据。
 */
async function openOutputSink(key) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OUT_DIR, { create: true });
  const name = `${sanitizeName(key, 'out')}.mp4`;
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

async function dropOutputFile(key) {
  if (!key) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OUT_DIR);
    await dir.removeEntry(`${sanitizeName(key, 'out')}.mp4`);
  } catch {
    /* 不存在就算了 */
  }
}

async function partBytes(part) {
  if (part instanceof Uint8Array) return part;
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (part && typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  throw new Error('分片数据无法读取');
}

/**
 * 把已落盘的 TS 分片流式重封装成标准 MP4。
 *
 * 一遍读完即写完：解析出的每一帧立刻追加进 mdat，进程内只留每帧十几字节的
 * 元数据。所以 1.5GB 和 50MB 的内存占用几乎一样 —— 这是 ffmpeg.wasm 做不到的。
 *
 * @returns {Promise<{blob: Blob, size: number, video: number, audio: number}>}
 */
async function remuxPartsToMp4(ctx, videoParts, audioParts, onProgress) {
  const sink = await openOutputSink(ctx.downloadKey);
  const muxer = new Mp4Muxer(sink);

  const feed = async (demux, parts, label, base, span) => {
    for (let i = 0; i < parts.length; i += 1) {
      assertLive(ctx);
      demux.push(await partBytes(parts[i]));
      await muxer.flush();
      if (onProgress) onProgress(base + ((i + 1) / parts.length) * span, label, i + 1, parts.length);
      // 每 8 个分片让出一次事件循环：解封装过程会产生大量短命 ArrayBuffer，
      // 不让出的话 GC 没有调度窗口，临时内存会一直堆到分片数上限才回收。
      if ((i & 7) === 7) await new Promise((r) => setTimeout(r, 0));
    }
    return demux.end();
  };

  try {
    // 视频轨：分离音轨时这里只有视频 PID；音视频复用时这里也会带出音频
    const vDemux = new TsDemuxer({ onSample: (s) => muxer.addSample(s) });
    await feed(vDemux, videoParts, '重封装视频', 0.86, 0.06);

    if (!vDemux.sps || !vDemux.pps) {
      throw new Error(vDemux.unsupported ? `暂不支持 ${vDemux.unsupported} 视频` : '没解析到 H.264 参数集（SPS/PPS）');
    }
    muxer.setVideoConfig({
      width: vDemux.size ? vDemux.size.width : 0,
      height: vDemux.size ? vDemux.size.height : 0,
      sps: vDemux.sps,
      pps: vDemux.pps
    });

    let audioCfg = vDemux.audioConfig;
    if (audioParts) {
      const aDemux = new TsDemuxer({ onSample: (s) => muxer.addSample(s) });
      await feed(aDemux, audioParts, '重封装音频', 0.92, 0.05);
      audioCfg = aDemux.audioConfig || audioCfg;
    }
    if (audioCfg) {
      muxer.setAudioConfig({
        sampleRate: audioCfg.sampleRate,
        channels: audioCfg.channels,
        asc: audioCfg.asc
      });
    }

    const res = await muxer.finish();
    if (!res.video) throw new Error('没有解析出任何视频帧');
    const file = await sink.file();
    return {
      // ftyp + moov 是内存里的几百 KB，mdat 直接引用 OPFS 文件，不复制数据
      blob: new Blob([res.head, file], { type: 'video/mp4' }),
      size: res.head.length + file.size,
      video: res.video,
      audio: res.audio
    };
  } catch (e) {
    await sink.abort();
    await dropOutputFile(ctx.downloadKey);
    throw e;
  }
}

/**
 * ffmpeg 兜底路径（老逻辑）。只在流式重封装失败、且文件小到 wasm 扛得住时使用，
 * 用来兼容极少见的非标准封装，不是主路径。
 */
async function muxViaFFmpeg(ctx, videoParts, audioParts, totalBytes) {
  holdBytes(ctx, totalBytes);
  await progress(ctx, 0.9, '加载 ffmpeg 引擎');
  await getFFmpeg();
  if (muxBusy) await stage(ctx, '排队等待转封装（引擎被其他任务占用）');
  await progress(ctx, 0.94, '转封装为 MP4');
  const mp4 = await enqueueMux(async () => {
    muxBusy = true;
    try {
      assertLive(ctx);
      const videoBytes = await joinToBytes(videoParts);
      const audioBytes = audioParts ? await joinToBytes(audioParts) : null;
      return await muxToMp4(ctx, videoBytes, audioBytes);
    } finally {
      muxBusy = false;
    }
  });
  return new Blob([mp4], { type: 'video/mp4' });
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
  // 0) 打开分片目录。同一个视频重新点下载会命中上次残留的分片，直接续传。
  ctx.downloadKey = ctx.downloadKey || job.downloadKey || resumeKeyOf(job.variantUrl || job.url);
  try {
    ctx.store = await openStore(ctx.downloadKey);
  } catch {
    ctx.store = null; // 落盘不可用就退回全内存，功能不受影响，只是没有续传
  }
  if (ctx.store) {
    const active = new Set([...jobs.values()].map((c) => c.downloadKey).filter(Boolean));
    void pruneStores(active).catch(() => 0);
  }

  // 1) 解析播放列表
  await progress(ctx, 0.02, ctx.store ? '解析播放列表（支持断点续传）' : '解析播放列表');

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
  const video = await downloadTrack(ctx, playlistUrl, '视频轨', 'v', (d, t) => {
    void progress(ctx, 0.05 + (d / t) * 0.7, `下载分片 ${d}/${t}`, { received: d, total: t });
  });

  assertLive(ctx);

  // 3) 独立音轨（master 用 EXT-X-MEDIA 分离音频时才会有）
  let audio = null;
  if (job.audioUrl && job.audioUrl !== playlistUrl) {
    await stage(ctx, '下载音轨分片');
    audio = await downloadTrack(ctx, job.audioUrl, '音频轨', 'a', (d, t) => {
      void progress(ctx, 0.75 + (d / t) * 0.15, `下载音轨 ${d}/${t}`, { received: d, total: t });
    });
  }

  assertLive(ctx);

  if (ctx.store) await stage(ctx, '校验分片完整性');
  const videoParts = await orderedTrackParts(video);
  const audioParts = audio ? await orderedTrackParts(audio) : null;
  const totalBytes = sumSizes(videoParts) + (audioParts ? sumSizes(audioParts) : 0);
  const totalMB = (totalBytes / 1024 / 1024).toFixed(0);

  let ext = job.output === 'ts' && !video.isFmp4 ? 'ts' : 'mp4';

  // 分片在 OPFS 里是 File 句柄，Blob 直接引用、不复制数据；
  // Chrome 会把大 Blob 落到磁盘，内存占用与文件大小基本无关。
  // 有独立音轨时按段交错，保证声画同步。
  const buildTsBlob = () => {
    const parts = audioParts ? interleaveBlobs(videoParts, audioParts) : videoParts;
    return new Blob(parts, { type: 'video/mp2t' });
  };

  // 4) 输出
  let blob;
  if (ext === 'ts') {
    await progress(ctx, 0.93, '拼接 TS');
    blob = buildTsBlob();
  } else if (video.isFmp4) {
    // fMP4 的 init 段 + 媒体分片本身就是合法 MP4 片段，顺序拼接即可。
    // 以前这里会为了「转封装」起一个 30MB 的 wasm 引擎，纯粹白费功夫。
    await progress(ctx, 0.93, '拼接 MP4 分片');
    const parts = audioParts ? interleaveBlobs(videoParts, audioParts) : videoParts;
    blob = new Blob(parts, { type: 'video/mp4' });
  } else {
    // TS → MP4：自研流式重封装。
    // 不重编码，mdat 边生成边落盘，内存只留每帧十几字节的元数据，
    // 所以 1.5GB 也不会 OOM —— 不再需要「超过 900MB 自动降级成 TS」。
    try {
      await stage(ctx, '重封装为 MP4');
      const out = await remuxPartsToMp4(ctx, videoParts, audioParts, (ratio, label, d, t) => {
        void progress(ctx, ratio, `${label} ${d}/${t}`, { received: d, total: t });
      });
      blob = out.blob;
    } catch (e) {
      if (ctx.cancelled) throw e;
      const why = errorText(e);
      if (totalBytes <= LIMIT_MP4_BYTES) {
        // 小文件还有退路：交给 ffmpeg 兜一把（老路径，兼容非常规封装）
        await stage(ctx, `流式重封装失败（${why}），改用 ffmpeg 引擎重试`);
        blob = await muxViaFFmpeg(ctx, videoParts, audioParts, totalBytes);
      } else {
        // 大文件交给 ffmpeg 只会 OOM，直接给能播的 TS，至少不白下
        await stage(ctx, `流式重封装失败（${why}），${totalMB}MB 改用 TS 直出`);
        ext = 'ts';
        blob = buildTsBlob();
      }
    }
  }

  assertLive(ctx);
  await progress(ctx, 0.99, '生成下载文件');

  const blobUrl = URL.createObjectURL(blob);
  if (ctx.downloadKey) blobOutputs.set(blobUrl, ctx.downloadKey);

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

    // 同一个视频不能有两个任务同时写同一份分片目录，否则会互相覆盖
    const key = msg.job.downloadKey || resumeKeyOf(msg.job.variantUrl || msg.job.url);
    for (const other of jobs.values()) {
      if (other.downloadKey && other.downloadKey === key) {
        sendResponse({ ok: false, error: '这个视频已经在下载中，请等它结束或先取消' });
        return true;
      }
    }

    const ctx = makeCtx(jobId);
    ctx.downloadKey = key;
    jobs.set(jobId, ctx);
    sendResponse({ ok: true });

    runJob(msg.job, ctx)
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
    const key = blobOutputs.get(msg.blobUrl);
    if (key) {
      blobOutputs.delete(msg.blobUrl);
      void dropOutputFile(key);
    }
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});
