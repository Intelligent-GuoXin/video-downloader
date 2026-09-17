/**
 * Offscreen document：HLS 分片下载 / AES-128 解密 / ffmpeg.wasm 转封装。
 *
 * 为什么不放在 Service Worker：SW 没有 DOM、30 秒空闲就被回收，且 ffmpeg.wasm 需要
 * Worker + WebAssembly，只能在真正有 DOM 的页面里跑。
 */

import { parsePlaylist, ivFromHex, ivFromSequence } from './lib/m3u8.js';
import { sanitizeName, hostOf } from './lib/media.js';

const LIMIT_MP4_BYTES = 900 * 1024 * 1024; // 超过这个体积走 MP4 转封装大概率 OOM
const CONCURRENCY = 6;

let current = null; // { jobId, cancelled }
let ffmpegInstance = null;
let ffmpegLoading = null;

// ---------------------------------------------------------------------------
// 与 Service Worker 通信
// ---------------------------------------------------------------------------

function report(payload) {
  return chrome.runtime.sendMessage({ target: 'sw', ...payload }).catch(() => null);
}

const stage = (jobId, text) => report({ type: 'JOB_STAGE', jobId, stage: text });

let lastProgressAt = 0;
function progress(jobId, ratio, text, extra = {}) {
  const now = Date.now();
  if (now - lastProgressAt < 250 && ratio < 1) return;
  lastProgressAt = now;
  return report({
    type: 'JOB_PROGRESS',
    jobId,
    stage: text,
    progress: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    ...extra
  });
}

// ---------------------------------------------------------------------------
// 网络工具
// ---------------------------------------------------------------------------

async function fetchBytes(url, range, asText = false) {
  const headers = {};
  if (range && Number.isFinite(range.length)) {
    const start = Number.isFinite(range.offset) ? range.offset : 0;
    headers.Range = `bytes=${start}-${start + range.length - 1}`;
  }
  const res = await fetch(url, { headers, credentials: 'include' });
  if (!res.ok && res.status !== 206) {
    let tail = url;
    try {
      tail = new URL(url).pathname.slice(-40);
    } catch {
      /* 保持原样 */
    }
    throw new Error(`请求失败 ${res.status}：${tail}`);
  }
  if (asText) return res.text();
  return new Uint8Array(await res.arrayBuffer());
}

const fetchText = (url) => fetchBytes(url, null, true);

async function pool(total, limit, worker) {
  let next = 0;
  const size = Math.max(1, Math.min(limit || CONCURRENCY, total));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= total) return;
      if (current && current.cancelled) return;
      await worker(i);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// 分片下载 + 解密
// ---------------------------------------------------------------------------

const keyCache = new Map();

async function decryptSegment(data, key, seq) {
  let cryptoKey = keyCache.get(key.url);
  if (!cryptoKey) {
    const raw = await fetchBytes(key.url);
    cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    keyCache.set(key.url, cryptoKey);
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
async function downloadPlaylistParts(playlistUrl, label, onTick) {
  const text = await fetchText(playlistUrl);
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

  await pool(total, CONCURRENCY, async (i) => {
    const seg = pl.segments[i];
    let data = await fetchBytes(seg.url, seg.byteRange);
    if (seg.key && seg.key.method === 'AES-128' && seg.key.url) {
      try {
        data = await decryptSegment(data, seg.key, seg.seq);
      } catch (e) {
        const detail = String(e && e.message ? e.message : e);
        throw new Error(`第 ${i + 1}/${total} 个分片解密失败（AES-128）：${detail}`);
      }
    }
    out[i] = data;
    done += 1;
    if (onTick) onTick(done, total);
  });

  const parts = [];
  // fMP4 的初始化段必须排在最前面，否则解不出来
  if (pl.map && pl.map.url) parts.push(await fetchBytes(pl.map.url));
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
 */
async function muxToMp4(videoBytes, audioBytes, jobId) {
  const ff = await getFFmpeg();
  const vName = 'video.bin';
  const aName = 'audio.bin';
  const outName = 'out.mp4';

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

  let rc = await ff.exec(build(true));
  if (rc !== 0) {
    await stage(jobId, '首次封装失败，改用兼容模式重试');
    await safeDelete(ff, outName);
    rc = await ff.exec(build(false));
  }
  if (rc !== 0) throw new Error('ffmpeg 转封装失败，可能是不支持的编码格式');

  const data = await ff.readFile(outName);
  await safeDelete(ff, vName);
  await safeDelete(ff, aName);
  await safeDelete(ff, outName);
  return new Uint8Array(data);
}

// ---------------------------------------------------------------------------
// 任务主流程
// ---------------------------------------------------------------------------

function buildFilename(job, ext) {
  const host = sanitizeName(job.host || hostOf(job.pageUrl) || 'video', 'site');
  const base = sanitizeName(job.title || host, 'video');
  return `视频嗅探/${host}/${base}-${job.id.slice(-5)}.${ext}`;
}

async function runJob(job) {
  const jobId = job.id;
  keyCache.clear();

  // 1) 解析播放列表
  await progress(jobId, 0.02, '解析播放列表');

  let playlistUrl = job.variantUrl || job.url;
  let text = await fetchText(playlistUrl);
  let pl = parsePlaylist(text, playlistUrl);

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

  // 2) 视频轨
  let done = 0;
  const video = await downloadPlaylistParts(playlistUrl, '视频轨', (d, t) => {
    done = d;
    void progress(jobId, 0.05 + (d / t) * 0.7, `下载分片 ${d}/${t}`, { received: d, total: t });
  });
  void done;

  if (current && current.cancelled) throw new Error('已取消');

  // 3) 独立音轨（master 用 EXT-X-MEDIA 分离音频时才会有）
  let audio = null;
  if (job.audioUrl && job.audioUrl !== playlistUrl) {
    await stage(jobId, '下载音轨分片');
    audio = await downloadPlaylistParts(job.audioUrl, '音频轨', (d, t) => {
      void progress(jobId, 0.75 + (d / t) * 0.15, `下载音轨 ${d}/${t}`, { received: d, total: t });
    });
  }

  if (current && current.cancelled) throw new Error('已取消');

  const ext = job.output === 'ts' && !video.isFmp4 ? 'ts' : 'mp4';

  // 4) 输出
  let outBytes;
  if (ext === 'ts') {
    // 纯拼接，秒级完成、零依赖。有独立音轨时按段交错，保证声画同步。
    await progress(jobId, 0.93, '拼接 TS');
    outBytes = concatParts(audio ? interleaveParts(video.parts, audio.parts) : video.parts);
  } else {
    const videoBytes = concatParts(video.parts);
    const audioBytes = audio ? concatParts(audio.parts) : null;
    const sumBytes = videoBytes.byteLength + (audioBytes ? audioBytes.byteLength : 0);

    if (sumBytes > LIMIT_MP4_BYTES) {
      throw new Error(
        `分片总大小约 ${(sumBytes / 1024 / 1024).toFixed(0)}MB，超过浏览器内转封装的安全上限。` +
          '请改用「TS 直出」格式下载，再用本机播放器/VLC 处理。'
      );
    }
    await progress(jobId, 0.9, '加载 ffmpeg 引擎');
    await getFFmpeg();
    await stage(jobId, '转封装为 MP4');
    await progress(jobId, 0.94, '转封装为 MP4');
    outBytes = await muxToMp4(videoBytes, audioBytes, jobId);
  }

  await progress(jobId, 0.99, '生成下载文件');

  const mime = ext === 'ts' ? 'video/mp2t' : 'video/mp4';
  const blobUrl = URL.createObjectURL(new Blob([outBytes], { type: mime }));

  await report({
    type: 'JOB_READY',
    jobId,
    blobUrl,
    filename: buildFilename(job, ext),
    mime,
    size: outBytes.byteLength
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
        const mp4 = await muxToMp4(new Uint8Array(gen), null, 'selftest');
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
    if (current && !current.cancelled) {
      sendResponse({ ok: false, error: '已有任务在跑' });
      return true;
    }
    current = { jobId: msg.job.id, cancelled: false };
    sendResponse({ ok: true });
    runJob(msg.job)
      .catch(async (e) => {
        const message = String(e && e.message ? e.message : e);
        await report({ type: 'JOB_ERROR', jobId: msg.job.id, message });
      })
      .finally(() => {
        if (current && current.jobId === msg.job.id) current = null;
      });
    return true;
  }

  if (msg.type === 'JOB_CANCEL') {
    if (current && current.jobId === msg.jobId) current.cancelled = true;
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
