/**
 * 直链任务：受限直链抓取、音视频分离合并、fMP4 分片流转换。
 *
 * 三种形态：
 * 1. 普通直链 —— 抓下来原样保存；
 * 2. 音视频分离下发（抖音/快手常见）—— 视频、音频各抓一份，再用
 *    lib/mp4remux.js 无损合成一个 MP4；
 * 3. fMP4 分片流 —— 抖音的 MSE 链路给的是 moov + 一串 moof/mdat，能完整下载，
 *    但 `<video src>` 和多数播放器不认。这里把样本表从 moof 搬进 stbl，
 *    转成普通的 moov 前置 MP4。
 *
 * 合并 / 转换都走纯 JS remux（搬 stsd + 重排样本表），不重编码。
 *
 * 配对安全（0.5.0 起的硬规则）：合并前双方时长必须已知且对得上（差 ≤ 0.8s 或 2%）。
 * 信息流页面会同时预加载多条视频，各自的音轨混在同一页里；时长是唯一低成本的
 * 「属于同一个视频」证据，对不上的一律拒绝合并 —— 宁可交付只有画面的文件，
 * 也绝不把别人的声音接到这个画面上。
 */

import { parseTrackKinds } from '../lib/mp4probe.js';
import { mergeMp4Tracks, isFragmented, remuxFragmentedMp4, loadMp4Index } from '../lib/mp4remux.js';
import { openOutputSink, dropOutputFile } from '../lib/outputsink.js';
import { stage, progress, report, assertLive, errorText, PROGRESS_THROTTLE } from '../offscreen/core.js';
import { registerBlobOutput } from '../offscreen/registry.js';

/** 时长匹配容差：绝对 0.8s 或相对 2%，取大者 */
const DURATION_TOL = (d) => Math.max(0.8, d * 0.02);

/**
 * 探一次地址能不能直接拿，顺便认一下这条流里有几条轨道。
 *
 * 为什么不直接用 chrome.downloads.download 试：那个请求由浏览器下载器发起，
 * 扩展的 DNR 规则对它不生效（实测同一条 referer 规则下，fetch 200、下载 403）。
 * 所以先在这里探一个字节，再决定走「浏览器下载」还是「抓下来另存」。
 *
 * 顺带取 64KB 头部解析 moov：抖音这类站点会把音视频拆成两个文件，
 * 只有认出「仅视频 / 仅音频」才能配对合并。
 *
 * @returns {Promise<{status:number, ok:boolean, tracks:object|null, mime:string, total:number}>}
 */
export async function probeUrl(url) {
  const empty = { status: 0, ok: false, tracks: null, mime: '', total: 0 };
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-65535' },
      credentials: 'include',
      priority: 'high',
      cache: 'no-store'
    });
    const ok = res.ok || res.status === 206;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    let total = Number(res.headers.get('content-length')) || 0;
    const range = res.headers.get('content-range') || ''; // bytes 0-65535/2809012
    const slash = range.lastIndexOf('/');
    if (slash > 0) total = Number(range.slice(slash + 1)) || total;

    let tracks = null;
    if (ok && res.body) {
      try {
        const buf = new Uint8Array(await res.arrayBuffer());
        tracks = parseTrackKinds(buf);
      } catch {
        /* 头部读失败不影响下载 */
      }
    }
    return { status: res.status, ok, tracks, mime, total };
  } catch (e) {
    return { ...empty, error: errorText(e) };
  }
}

/**
 * 把一条 URL 抓成 OPFS 里的文件，边收边写，内存不随体积增长。
 * @returns {Promise<{sink:object, size:number, mime:string, ext:string}>}
 */
async function downloadToOpfs(ctx, url, key, ext, label, ratioFrom, ratioSpan) {
  const res = await fetch(url, {
    credentials: 'include',
    signal: ctx.signal,
    priority: 'high',
    cache: 'no-store'
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(
      `${label}被拒绝（HTTP ${res.status}）` + '：可能链接已过期或需要登录，重新播放一下再嗅探'
    );
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const sink = await openOutputSink(key, ext);
  let received = 0;
  let lastTick = 0;

  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        assertLive(ctx);
        if (value && value.byteLength) {
          await sink.write(value);
          received += value.byteLength;
          const now = Date.now();
          if (now - lastTick > PROGRESS_THROTTLE) {
            lastTick = now;
            const ratio = total ? Math.min(1, received / total) : 0;
            void progress(ctx, ratioFrom + ratio * ratioSpan, `${label} ${(received / 1048576).toFixed(1)}MB`, {
              received,
              total
            });
          }
        }
      }
    } else {
      // 极少数情况拿不到流：退回整块读（视频不大时才可接受）
      const buf = new Uint8Array(await res.arrayBuffer());
      await sink.write(buf);
      received = buf.byteLength;
    }

    assertLive(ctx);
    await sink.close();
  } catch (e) {
    await sink.abort();
    await dropOutputFile(key, ext);
    // fetch 在 Content-Length 没兑现时只抛一句 "network error"，用户看不懂。
    // 这里把已收到的量和声明量一起说出来，指向「连接断了、不是链接失效」。
    if (!ctx.cancelled && received > 0 && total && received < total) {
      throw new Error(
        `${label}中断：只收到 ${(received / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB。` +
          '连接被掐断了，重试一次通常就好'
      );
    }
    throw e;
  }

  if (!received) {
    await dropOutputFile(key, ext);
    throw new Error(`${label}返回了空内容`);
  }

  // 服务端声明了长度却没给够：连接被中途掐断（大文件、长连接、代理超时都会发生）。
  // 早期版本只看 received > 0，截断的文件被当成成功保存，用户拿到一个
  // 「moov 说 100 秒、实际只有几秒数据」的残片，播放器直接报错。
  if (total && received < total) {
    await dropOutputFile(key, ext);
    throw new Error(
      `${label}不完整：只收到 ${(received / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB，` +
        '连接被中断。请重试（换个网络或稍后再试）'
    );
  }

  const mime = (res.headers.get('content-type') || '').split(';')[0].trim() || 'video/mp4';
  return { sink, size: received, mime, ext };
}

/**
 * 确保手上是「标准 MP4」（moov 前置、样本表在 stbl 里）。
 * 分片流（fMP4）会被转成标准 MP4；普通 MP4 原样返回。
 *
 * @param {object} opts
 * @param {File} opts.file 源文件（OPFS 句柄）
 * @param {string} opts.key 源文件在 OPFS 里的 key
 * @param {string} opts.convKey 转换产物的 key
 * @param {string} opts.label 进度文案里的名字
 * @param {boolean} opts.checkPartial 是否校验「只覆盖了声明的不到一半时长」
 * @returns {Promise<{file:File, key:string, converted:boolean, result:object|null}>}
 */
async function ensureStandardMp4(ctx, { file, key, convKey, label, checkPartial, ratioFrom, ratioSpan }) {
  const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  if (!isFragmented(head)) return { file, key, converted: false, result: null };

  await stage(ctx, `${label}是分片流，转成标准 MP4`);
  const convSink = await openOutputSink(convKey, 'mp4');
  try {
    const result = await remuxFragmentedMp4({
      src: file,
      sink: convSink,
      onProgress: (ratio, text) => {
        void progress(ctx, ratioFrom + ratio * ratioSpan, text);
      }
    });
    // 只下到前面几个分片时，moov 里声明的时长会远大于实际覆盖的时长。
    // 这种交付出去等于「能播但只有几秒」，明确告诉用户而不是让他自己发现。
    if (checkPartial && result.declaredDuration > 1 && result.duration < result.declaredDuration * 0.5) {
      throw new Error(
        `这条分片流只包含 ${result.duration.toFixed(1)} 秒（全长 ${result.declaredDuration.toFixed(1)} 秒）。` +
          '请回到播放器把视频完整播一遍再重新嗅探下载'
      );
    }
    return { file: await convSink.file(), key: convKey, converted: true, result };
  } catch (e) {
    await convSink.abort();
    throw new Error(`${label}分片流转换失败：${errorText(e)}`);
  }
}

/** 双方时长都已知时，判断是否属于同一个视频 */
function durationMatches(a, b) {
  return Boolean(a && b) && Math.abs(a - b) <= DURATION_TOL(Math.max(a, b));
}

// ---------------------------------------------------------------------------
// 任务主流程
// ---------------------------------------------------------------------------

export async function runDirectJob(job, ctx) {
  const ext = job.ext || 'mp4';
  ctx.downloadKey = 'direct-' + ctx.jobId;
  const audioKey = ctx.downloadKey + '-a';
  const outKey = ctx.downloadKey + '-out';

  await progress(ctx, 0.02, '连接地址');
  const main = await downloadToOpfs(ctx, job.url, ctx.downloadKey, ext, '下载', 0.02, job.audioUrl ? 0.45 : 0.6);

  let blob;
  let keepKey;
  let note = '';

  if (job.audioUrl) {
    // ---- 形态 2：用户（或界面）明确指定了音轨，两路抓取后合并 ----
    const audio = await downloadToOpfs(ctx, job.audioUrl, audioKey, 'mp4', '下载音轨', 0.47, 0.28);

    // 任何一侧可能是分片流（手动配对时不保证），先各自转成标准 MP4
    const video = await ensureStandardMp4(ctx, {
      file: await main.sink.file(),
      key: ctx.downloadKey,
      convKey: outKey + '-v',
      label: '视频轨',
      checkPartial: true,
      ratioFrom: 0.75,
      ratioSpan: 0.05
    });
    const audioStd = await ensureStandardMp4(ctx, {
      file: await audio.sink.file(),
      key: audioKey,
      convKey: outKey + '-a',
      label: '音轨',
      checkPartial: false,
      ratioFrom: 0.8,
      ratioSpan: 0.04
    });

    // 时长硬校验：对不上说明这是别的视频的音轨。
    // 「总能下错」的一个来源就是这里以前不看时长直接合 —— 现在宁可失败也不串轨。
    const vIdx = await loadMp4Index(video.file);
    const aIdx = await loadMp4Index(audioStd.file);
    if (vIdx && aIdx && vIdx.duration && aIdx.duration && !durationMatches(vIdx.duration, aIdx.duration)) {
      await dropOutputFile(video.key, video.converted ? 'mp4' : ext);
      await dropOutputFile(audioStd.key, 'mp4');
      throw new Error(
        `音轨时长对不上（视频 ${vIdx.duration.toFixed(1)} 秒 / 音轨 ${aIdx.duration.toFixed(1)} 秒），` +
          '这多半是同页另一个视频的音轨，已停止合并。请在列表里选择时长一致的音频条目'
      );
    }

    const totalMB = ((video.file.size + audioStd.file.size) / 1048576).toFixed(1);
    await stage(ctx, `合成音视频（${totalMB}MB，不重新编码）`);

    const outSink = await openOutputSink(outKey, 'mp4');
    try {
      const result = await mergeMp4Tracks({
        video: video.file,
        audio: audioStd.file,
        sink: outSink,
        onProgress: (ratio, text) => {
          void progress(ctx, 0.84 + ratio * 0.13, text);
        }
      });
      blob = new Blob([await outSink.file()], { type: 'video/mp4' });
      await stage(ctx, `合成完成：${result.videoSamples} 帧视频 + ${result.audioSamples} 帧音频`);
      keepKey = outKey;
    } catch (e) {
      await outSink.abort();
      if (ctx.cancelled) throw e;
      throw new Error(`音视频合成失败：${errorText(e)}`);
    } finally {
      // 两段源数据已经搬完，源文件立刻删掉
      void dropOutputFile(video.key, video.converted ? 'mp4' : ext);
      void dropOutputFile(audioStd.key, 'mp4');
    }
  } else {
    // ---- 形态 1 / 3：单条地址，按内容决定要不要转换、要不要自动找音轨 ----
    const video = await ensureStandardMp4(ctx, {
      file: await main.sink.file(),
      key: ctx.downloadKey,
      convKey: outKey,
      label: '',
      checkPartial: true,
      ratioFrom: 0.6,
      ratioSpan: 0.12
    });
    if (video.result) {
      await stage(ctx, `已转成标准 MP4：${video.result.videoSamples} 帧 / ${video.result.duration.toFixed(1)} 秒`);
    }
    let finalFile = video.file;
    let finalKey = video.key;

    // 抖音 DASH：视频流、音频流是两条独立地址，分片 URL 上探不出轨道，
    // 到这里才知道手上是「只有画面」还是「只有声音」。
    // 下载时自动试同页最近的候选，找到「时长对得上」的纯音轨就合并成交一个文件。
    if (job.audioCandidates && job.audioCandidates.length) {
      const idx = await loadMp4Index(finalFile);
      const hasVideo = idx && idx.tracks.some((t) => t.handler === 'vide' && t.samples.length);
      const hasAudio = idx && idx.tracks.some((t) => t.handler === 'soun' && t.samples.length);

      if (hasVideo && !hasAudio) {
        const merged = await tryAudioCandidates(ctx, finalFile, idx, job.audioCandidates, ctx.downloadKey);
        if (merged) {
          finalFile = merged.file;
          finalKey = merged.key;
          note = `已自动匹配音轨并合并（${merged.result.videoSamples} 帧视频 + ${merged.result.audioSamples} 帧音频）`;
        } else {
          note = '没有找到时长对得上的音轨，只保存了画面（宁缺勿错，不会把别的视频的声音接上来）';
        }
      } else if (!hasVideo && hasAudio) {
        note = '这条地址只有声音。请在列表里找对应的视频流一起下载';
      }
    }

    blob = new Blob([finalFile], { type: 'video/mp4' });
    keepKey = finalKey;
    // 源文件（转换前的那份）已经没有保留价值
    if (video.converted && video.key !== finalKey) void dropOutputFile(video.key, ext);
  }

  const blobUrl = URL.createObjectURL(blob);
  // 合并产物在 OPFS 里留一份，下载完成后再清
  registerBlobOutput(blobUrl, keepKey, 'mp4');

  if (note) await stage(ctx, note);
  await progress(ctx, 0.99, '生成下载文件');
  await report({
    type: 'JOB_READY',
    jobId: ctx.jobId,
    blobUrl,
    filename: job.filename,
    mime: blob.type,
    size: blob.size
  });
}

/**
 * 抖音 DASH 的下载时配对：依次抓同页候选地址，认出「时长对得上的纯音轨」就合并。
 *
 * 候选可能是普通 MP4，也可能是 fMP4（分片流），后者先转成普通 MP4 才能进合成器。
 * 每个候选失败 / 不是音轨 / 时长未知 / 时长对不上都跳过，全部落空返回 null——
 * 宁可交付只有画面的文件，也不把别人的声音硬配上去。
 *
 * @returns {Promise<{file: File, key: string, result: object} | null>}
 */
async function tryAudioCandidates(ctx, videoFile, videoIndex, candidates, baseKey) {
  const vDur = videoIndex ? videoIndex.duration : 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const key = `${baseKey}-c${i}`;
    const convKey = `${key}-out`;
    let audioFile = null;
    let convUsed = false;

    try {
      await stage(ctx, `自动匹配音轨（${i + 1}/${candidates.length}）`);
      const r = await downloadToOpfs(ctx, candidates[i], key, 'mp4', '拉取候选音轨', 0.72, 0.16);
      audioFile = await r.sink.file();

      const head = new Uint8Array(await audioFile.slice(0, 262144).arrayBuffer());
      if (isFragmented(head)) {
        const convSink = await openOutputSink(convKey, 'mp4');
        try {
          await remuxFragmentedMp4({
            src: audioFile,
            sink: convSink,
            onProgress: (ratio, text) => {
              void progress(ctx, 0.88 + ratio * 0.04, text);
            }
          });
          audioFile = await convSink.file();
          convUsed = true;
        } catch (e) {
          await convSink.abort();
          throw e;
        }
      }

      const aIdx = await loadMp4Index(audioFile);
      if (!aIdx) continue;
      const hasV = aIdx.tracks.some((t) => t.handler === 'vide' && t.samples.length);
      const aTrack = aIdx.tracks.find((t) => t.handler === 'soun' && t.samples.length);
      if (!aTrack || hasV) continue; // 不是纯音轨

      // 时长必须双方都已知且对得上：
      // - 对不上 → 一定是别的视频的音轨；
      // - 任一方未知 → 无法验证，同样不配（早期版本这里放行了「视频时长未知」
      //   的候选，是「总是下错视频」的直接原因之一）。
      if (!vDur || !aIdx.duration || !durationMatches(vDur, aIdx.duration)) continue;

      const outKey = baseKey + '-m';
      const outSink = await openOutputSink(outKey, 'mp4');
      const result = await mergeMp4Tracks({
        video: videoFile,
        audio: audioFile,
        sink: outSink,
        onProgress: (ratio, text) => {
          void progress(ctx, 0.92 + ratio * 0.06, text);
        }
      });
      // 合并完成后，候选的两份临时文件都没用了
      void dropOutputFile(key, 'mp4');
      if (convUsed) void dropOutputFile(convKey, 'mp4');
      return { file: await outSink.file(), key: outKey, result };
    } catch (e) {
      if (ctx.cancelled) throw e;
      // 候选抓取失败（链接过期 / 403）很常见，跳过试下一个
      void dropOutputFile(key, 'mp4');
      if (convUsed) void dropOutputFile(convKey, 'mp4');
      continue;
    }
  }
  return null;
}
