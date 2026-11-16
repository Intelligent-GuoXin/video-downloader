/**
 * HLS 任务：播放列表解析 → 分片并发下载（AES-128 解密）→ 输出。
 *
 * 断点续传（0.3.0）：
 * - 分片下载完立刻写进 OPFS（见 lib/segstore.js），不再攒在内存里。
 * - 任务失败 / 取消 / 浏览器重启后，同一个视频重新点下载会跳过已下载的分片，
 *   从断点继续；只有播放列表片数变了才判定为「换了内容」，清掉重下。
 * - 单个分片失败不再直接判死整个任务：重试 4 次（指数退避 + 抖动）。
 *
 * 输出格式：
 * - TS 直出：分片顺序拼接（有独立音轨时按段交错），秒级完成；
 * - MP4 合流：lib/tsdemux + lib/mp4mux 流式重封装，不重编码、内存与文件大小无关。
 *   重封装失败时（非常规封装，如 HEVC TS）降级成 TS 直出并说明原因 ——
 *   至少交付一个能播的文件，绝不静默给一个打不开的产物。
 */

import { parsePlaylist, ivFromHex, ivFromSequence } from '../lib/m3u8.js';
import { resumeKeyOf, pathKey, hostOf } from '../lib/media.js';
import { openStore, pruneStores, segNameOf, initNameOf } from '../lib/segstore.js';
import { TsDemuxer } from '../lib/tsdemux.js';
import { Mp4Muxer } from '../lib/mp4mux.js';
import { openOutputSink, dropOutputFile, partBytes } from '../lib/outputsink.js';
import { fetchText, fetchBytes, fetchSegment, pool } from '../lib/transport.js';
import { stage, progress, report, assertLive, errorText, CONCURRENCY } from '../offscreen/core.js';
import { addActiveKey, activeKeyList, registerBlobOutput } from '../offscreen/registry.js';
import { buildFilename } from '../lib/naming.js';

const sizeOf = (p) => (p && p.size !== undefined ? p.size : p ? p.byteLength : 0);
const sumSizes = (list) => list.reduce((n, p) => n + sizeOf(p), 0);

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

/**
 * 下载一个 media playlist 的全部分片，边下边落盘。
 *
 * 续传判定：分片以「序号文件名」存在 OPFS 里，开工前先看已经有哪些，
 * 有的直接跳过。只有播放列表片数或封装格式变了，才认为不是同一份内容、清掉重下。
 *
 * @returns {{store: object|null, prefix: string, count: number, isFmp4: boolean, hasMap: boolean, resumed: number, parts: (Uint8Array[]|null), mapBytes: (Uint8Array|null)}}
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
// 流式重封装：TS → MP4（不重编码、无大小上限）
// ---------------------------------------------------------------------------

/**
 * 把已落盘的 TS 分片流式重封装成标准 MP4。
 *
 * 一遍读完即写完：解析出的每一帧立刻追加进 mdat，进程内只留每帧十几字节的
 * 元数据。所以 1.5GB 和 50MB 的内存占用几乎一样。
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

// ---------------------------------------------------------------------------
// 任务主流程
// ---------------------------------------------------------------------------

function jobFilename(job, ext) {
  return buildFilename({
    pageUrl: job.pageUrl,
    url: job.url,
    title: job.title || '',
    host: job.host || hostOf(job.pageUrl || job.url),
    uniq: job.id.slice(-5),
    ext
  });
}

export async function runHlsJob(job, ctx) {
  // 0) 打开分片目录。同一个视频重新点下载会命中上次残留的分片，直接续传。
  ctx.downloadKey = ctx.downloadKey || job.downloadKey || resumeKeyOf(job.variantUrl || job.url);
  try {
    ctx.store = await openStore(ctx.downloadKey);
  } catch {
    ctx.store = null; // 落盘不可用就退回全内存，功能不受影响，只是没有续传
  }
  if (ctx.store) {
    addActiveKey(ctx.downloadKey);
    void pruneStores(new Set(activeKeyList())).catch(() => 0);
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
    await progress(ctx, 0.93, '拼接 MP4 分片');
    const parts = audioParts ? interleaveBlobs(videoParts, audioParts) : videoParts;
    blob = new Blob(parts, { type: 'video/mp4' });
  } else {
    // TS → MP4：流式重封装（不重编码，mdat 边生成边落盘，内存与文件大小无关）。
    // 失败（HEVC / 非标准封装等）就降级 TS 直出：宁可给个能播的，不给打不开的。
    try {
      await stage(ctx, '重封装为 MP4');
      const out = await remuxPartsToMp4(ctx, videoParts, audioParts, (ratio, label, d, t) => {
        void progress(ctx, ratio, `${label} ${d}/${t}`, { received: d, total: t });
      });
      blob = out.blob;
    } catch (e) {
      if (ctx.cancelled) throw e;
      await stage(ctx, `重封装失败（${errorText(e)}），${totalMB}MB 改用 TS 直出`);
      ext = 'ts';
      blob = buildTsBlob();
    }
  }

  assertLive(ctx);
  await progress(ctx, 0.99, '生成下载文件');

  const blobUrl = URL.createObjectURL(blob);
  registerBlobOutput(blobUrl, ctx.downloadKey, ext);
  await report({
    type: 'JOB_READY',
    jobId: ctx.jobId,
    blobUrl,
    filename: jobFilename(job, ext),
    mime: blob.type,
    size: blob.size
  });
}
