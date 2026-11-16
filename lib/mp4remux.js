/**
 * 把「只有画面」和「只有声音」的两个 MP4 无损合成一个。
 *
 * 抖音 / 快手 / 部分课程站会把音视频拆成两个文件下发，浏览器里是一个视频，
 * 嗅探出来却是两条。分开存，用户拿到的是没声音的画面加一个音频文件。
 *
 * 做法是 remux 而不是转码：
 * - `stsd`（含 hvcC / avcC / esds 等编解码器配置）原样搬运，不解码不重编码；
 * - `tkhd` / `mdhd` / `hdlr` / `vmhd` / `smhd` / `dinf` 也原样搬，只改时长与轨道号；
 * - 两张样本表按时间戳归并，重新排 chunk，mdat 里只写原始帧数据。
 *
 * 因此画质音质与源文件完全一致，速度是纯 IO，且不依赖 ffmpeg.wasm
 * （后者要把两段数据一起塞进 wasm 内存，900MB 就 OOM）。
 *
 * 内存模型：常驻的只有每帧十几字节的元数据（stsz/stts/stco 展开后的数组），
 * 帧数据按 chunk 从源文件读、立刻写进目标，不整段驻留。
 *
 * 输入源接口：{ size:number, slice(start,end) => Blob }，File / Blob 直接满足。
 */

import { ByteWriter } from './mp4mux.js';

const MOVIE_TIMESCALE = 1000;
const READ_CHUNK = 4 * 1024 * 1024; // 每次从源读这么多，够填满一次写
const HEAD_PROBE = 2 * 1024 * 1024;

const VIDEO_HANDLERS = new Set(['vide']);
const AUDIO_HANDLERS = new Set(['soun']);

// ---------------------------------------------------------------------------
// 只读解析
// ---------------------------------------------------------------------------

function u32(buf, at) {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

function u64(buf, at) {
  return u32(buf, at) * 4294967296 + u32(buf, at + 4);
}

function i32(buf, at) {
  const v = u32(buf, at);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

function fourcc(buf, at) {
  return String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
}

/** 解析 [start, end) 里的直接子 box；越界或畸形就停，不抛错 */
function boxes(buf, start, end) {
  const out = [];
  let p = start;
  for (let guard = 0; guard < 8192 && p + 8 <= end; guard += 1) {
    let size = u32(buf, p);
    const type = fourcc(buf, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(buf, p + 8);
      header = 16;
    } else if (size === 0) {
      size = end - p; // 延伸到末尾
    }
    if (size < header || p + size > end) break;
    out.push({ type, size, body: p + header, end: p + size, at: p });
    p += size;
  }
  return out;
}

function child(buf, parent, type) {
  if (!parent) return null;
  return boxes(buf, parent.body, parent.end).find((b) => b.type === type) || null;
}

/** stts / ctts 这类「(count, value) 对」表的通用展开 */
function expandPairs(buf, box, n32) {
  const out = [];
  if (!box) return out;
  const count = u32(buf, box.body + 4);
  let p = box.body + 8;
  for (let i = 0; i < count && p + 8 <= box.end; i += 1, p += 8) {
    out.push([n32(p), n32(p + 4)]);
  }
  return out;
}

/**
 * 解析出一条 trak 的样本表。
 * @returns {null | {id, handler, codec, timescale, language, stsd, tkhd, mdhd, hdlr, vmhd, smhd, dinf, samples}}
 */
function readTrak(buf, trak) {
  const tkhd = child(buf, trak, 'tkhd');
  const mdia = child(buf, trak, 'mdia');
  if (!mdia) return null;
  const mdhd = child(buf, mdia, 'mdhd');
  const hdlr = child(buf, mdia, 'hdlr');
  if (!mdhd || !hdlr) return null;

  const handler = fourcc(buf, hdlr.body + 8);
  const minf = child(buf, mdia, 'minf');
  const stbl = child(buf, minf, 'stbl');
  if (!stbl) return null;
  const stsd = child(buf, stbl, 'stsd');

  const version = buf[mdhd.body];
  const timescale = version === 1 ? u32(buf, mdhd.body + 20) : u32(buf, mdhd.body + 12);
  if (!timescale) return null;

  const tkhdVersion = tkhd ? buf[tkhd.body] : 0;
  const trackId = tkhd ? (tkhdVersion === 1 ? u32(buf, tkhd.body + 20) : u32(buf, tkhd.body + 12)) : 1;

  const codec = stsd ? fourcc(buf, stsd.body + 12) : '';

  // ---- 每帧大小 ----
  const stszBox = child(buf, stbl, 'stsz');
  const sizes = [];
  if (stszBox) {
    const uniform = u32(buf, stszBox.body + 4);
    const count = u32(buf, stszBox.body + 8);
    if (uniform === 0) {
      for (let i = 0; i < count && stszBox.body + 12 + i * 4 + 4 <= stszBox.end; i += 1) {
        sizes.push(u32(buf, stszBox.body + 12 + i * 4));
      }
    } else {
      for (let i = 0; i < count; i += 1) sizes.push(uniform);
    }
  }

  // ---- chunk 表：stsc + stco/co64 ----
  const stcoBox = child(buf, stbl, 'stco');
  const co64Box = child(buf, stbl, 'co64');
  const chunkOffsets = [];
  if (stcoBox) {
    const n = u32(buf, stcoBox.body + 4);
    for (let i = 0; i < n && stcoBox.body + 8 + i * 4 + 4 <= stcoBox.end; i += 1) {
      chunkOffsets.push(u32(buf, stcoBox.body + 8 + i * 4));
    }
  } else if (co64Box) {
    const n = u32(buf, co64Box.body + 4);
    for (let i = 0; i < n && co64Box.body + 8 + i * 8 + 8 <= co64Box.end; i += 1) {
      chunkOffsets.push(u64(buf, co64Box.body + 8 + i * 8));
    }
  }

  const stscBox = child(buf, stbl, 'stsc');
  const stsc = [];
  if (stscBox) {
    const n = u32(buf, stscBox.body + 4);
    for (let i = 0; i < n && stscBox.body + 8 + i * 12 + 12 <= stscBox.end; i += 1) {
      const at = stscBox.body + 8 + i * 12;
      stsc.push({ first: u32(buf, at), perChunk: u32(buf, at + 4) });
    }
  }

  // ---- 时间戳 ----
  const stts = expandPairs(buf, child(buf, stbl, 'stts'), (p) => u32(buf, p));
  const ctts = expandPairs(buf, child(buf, stbl, 'ctts'), (p) => i32(buf, p));
  const stssBox = child(buf, stbl, 'stss');
  const syncSamples = new Set();
  if (stssBox) {
    const n = u32(buf, stssBox.body + 4);
    for (let i = 0; i < n && stssBox.body + 8 + i * 4 + 4 <= stssBox.end; i += 1) {
      syncSamples.add(u32(buf, stssBox.body + 8 + i * 4));
    }
  }

  if (!sizes.length || !chunkOffsets.length || !stsc.length) {
    return { id: trackId, handler, codec, timescale, stsd, tkhd, mdhd, hdlr, minf, samples: [] };
  }

  // ---- 展开成逐样本记录 ----
  const samples = [];
  let sampleIndex = 0;
  let fileOffset = 0;
  let dts = 0;
  let sttsAt = 0;
  let sttsLeft = stts.length ? stts[0][0] : 0;
  let sttsDelta = stts.length ? stts[0][1] : 0;
  let cttsAt = 0;
  let cttsLeft = ctts.length ? ctts[0][0] : 0;
  let cttsOffset = ctts.length ? ctts[0][1] : 0;
  const hasCtts = ctts.length > 0;

  outer: for (let c = 0; c < chunkOffsets.length; c += 1) {
    // 找到覆盖当前 chunk（1-based）的 stsc 条目
    let per = 0;
    for (const entry of stsc) {
      if (entry.first <= c + 1) per = entry.perChunk;
      else break;
    }
    if (!per) continue;

    fileOffset = chunkOffsets[c];
    for (let k = 0; k < per; k += 1) {
      if (sampleIndex >= sizes.length) break outer;

      while (sttsLeft === 0 && sttsAt + 1 < stts.length) {
        sttsAt += 1;
        sttsLeft = stts[sttsAt][0];
        sttsDelta = stts[sttsAt][1];
      }
      let cts = dts;
      if (hasCtts) {
        while (cttsLeft === 0 && cttsAt + 1 < ctts.length) {
          cttsAt += 1;
          cttsLeft = ctts[cttsAt][0];
          cttsOffset = ctts[cttsAt][1];
        }
        cts = dts + cttsOffset;
        if (cttsLeft > 0) cttsLeft -= 1;
      }

      samples.push({
        size: sizes[sampleIndex],
        dts,
        cts,
        key: syncSamples.size ? syncSamples.has(sampleIndex + 1) : true,
        offset: fileOffset
      });

      fileOffset += sizes[sampleIndex];
      dts += sttsDelta;
      if (sttsLeft > 0) sttsLeft -= 1;
      sampleIndex += 1;
    }
  }

  return {
    id: trackId,
    handler,
    codec,
    timescale,
    stsd,
    tkhd,
    mdhd,
    hdlr,
    minf,
    samples
  };
}

/** 从一段文件字节里认出所有轨道；拿不到 moov 返回 null */
export function parseMp4(buf, base = 0) {
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;

  const tracks = [];
  for (const trak of boxes(buf, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const t = readTrak(buf, trak);
    if (t && (VIDEO_HANDLERS.has(t.handler) || AUDIO_HANDLERS.has(t.handler))) tracks.push(t);
  }

  const fragmented = Boolean(child(buf, moov, 'mvex')) || top.some((b) => b.type === 'moof');
  let duration = 0;
  const mvhd = child(buf, moov, 'mvhd');
  if (mvhd) {
    const v = buf[mvhd.body];
    const ts = v === 1 ? u32(buf, mvhd.body + 20) : u32(buf, mvhd.body + 12);
    const du = v === 1 ? u64(buf, mvhd.body + 24) : u32(buf, mvhd.body + 16);
    duration = ts ? du / ts : 0;
  }
  if (!duration) {
    for (const t of tracks) {
      const last = t.samples[t.samples.length - 1];
      if (last) duration = Math.max(duration, last.dts / t.timescale);
    }
  }

  return { tracks, fragmented, duration, fileOffsetBase: base };
}

// ---------------------------------------------------------------------------
// 读源
// ---------------------------------------------------------------------------

async function readRange(src, start, end) {
  const clampedEnd = Math.min(end, src.size);
  if (clampedEnd <= start) return new Uint8Array(0);
  if (typeof src.read === 'function') return src.read(start, clampedEnd);
  const blob = src.slice(start, clampedEnd);
  return new Uint8Array(await blob.arrayBuffer());
}

/** 读出 moov（在头部或尾部都行）并解析 */
export async function loadMp4Index(src) {
  const headEnd = Math.min(src.size, HEAD_PROBE);
  let base = 0;
  let buf = await readRange(src, 0, headEnd);

  let top = boxes(buf, 0, buf.length);
  let moov = top.find((b) => b.type === 'moov');

  // moov 声明的大小超过我们读的量 → 把整个 moov 读进来
  if (moov && moov.at + moov.size > buf.length) {
    buf = await readRange(src, 0, moov.at + moov.size);
    top = boxes(buf, 0, buf.length);
    moov = top.find((b) => b.type === 'moov');
  }

  if (!moov) {
    // 老式 MP4 把 moov 放在文件尾
    const tailLen = Math.min(src.size, HEAD_PROBE * 2);
    base = src.size - tailLen;
    buf = await readRange(src, base, src.size);
    top = boxes(buf, 0, buf.length);
    moov = top.find((b) => b.type === 'moov');
    if (!moov) return null;
    // 尾部读到的 moov 若跨出窗口，从 moov 起点重读
    if (moov.at + moov.size > buf.length) {
      const absStart = base + moov.at;
      base = absStart;
      buf = await readRange(src, absStart, absStart + moov.size);
      top = boxes(buf, 0, buf.length);
      moov = top.find((b) => b.type === 'moov');
      if (!moov) return null;
    }
  }

  return { ...parseMp4(buf, base), buf };
}

// ---------------------------------------------------------------------------
// 写 moov
// ---------------------------------------------------------------------------

function sliceBox(buf, box) {
  return buf.subarray(box.at, box.end);
}

/** 改写 tkhd 里的 track_id / duration，其余原样 */
function patchTkhd(buf, box, newId, durationMovieTs) {
  const out = new Uint8Array(sliceBox(buf, box));
  const v = out[0];
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (v === 1) {
    view.setUint32(20, newId);
    view.setUint32(28, Math.floor(durationMovieTs / 4294967296));
    view.setUint32(32, durationMovieTs >>> 0);
  } else {
    view.setUint32(12, newId);
    view.setUint32(20, Math.min(durationMovieTs, 0xfffffffe));
  }
  return out;
}

/** 改写 mdhd 的 duration，timescale 保留 */
function patchMdhd(buf, box, durationTrackTs) {
  const out = new Uint8Array(sliceBox(buf, box));
  const v = out[0];
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (v === 1) {
    view.setUint32(24, Math.floor(durationTrackTs / 4294967296));
    view.setUint32(28, durationTrackTs >>> 0);
  } else {
    view.setUint32(16, Math.min(durationTrackTs, 0xfffffffe));
  }
  return out;
}

function runLength(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0] += 1;
    else out.push([1, v]);
  }
  return out;
}

/**
 * 用交错后的样本序列重建 stbl。
 * @param {{samples:object[], chunks:{offset:number, count:number}[], timescale:number}} track
 */
function buildStbl(track, ctx) {
  const { stsdBytes, samples, chunks } = track;
  const b = new ByteWriter(16384);

  b.box('stbl', () => {
    // stsd：编解码器配置原样搬（hvcC / avcC / esds 都在里面）
    b.bytes(stsdBytes);

    // stts
    const deltas = [];
    for (let i = 1; i < samples.length; i += 1) deltas.push(samples[i].dts - samples[i - 1].dts);
    const lastStep = deltas.length ? deltas[deltas.length - 1] : Math.round(track.timescale / 25);
    deltas.push(lastStep > 0 ? lastStep : 1);
    const stts = runLength(deltas);
    b.fullBox('stts', 0, 0, () => {
      b.u32(stts.length);
      for (const [count, delta] of stts) {
        b.u32(count);
        b.u32(Math.max(0, delta));
      }
    });

    // ctts：只有存在 B 帧偏移时才写
    const offsets = samples.map((s) => s.cts - s.dts);
    if (offsets.some((o) => o !== 0)) {
      const negative = offsets.some((o) => o < 0);
      const rle = runLength(offsets);
      b.fullBox('ctts', negative ? 1 : 0, 0, () => {
        b.u32(rle.length);
        for (const [count, off] of rle) {
          b.u32(count);
          b.u32(negative ? off >>> 0 : off);
        }
      });
    }

    // stss：关键帧表。全关键帧就不写（缺省视为全部同步帧）
    const keyIdx = [];
    samples.forEach((s, i) => {
      if (s.key) keyIdx.push(i + 1);
    });
    if (keyIdx.length && keyIdx.length !== samples.length) {
      b.fullBox('stss', 0, 0, () => {
        b.u32(keyIdx.length);
        for (const i of keyIdx) b.u32(i);
      });
    }

    // stsc：chunk 内样本数变化时新增一条
    const stsc = [];
    chunks.forEach((c, i) => {
      const last = stsc[stsc.length - 1];
      if (!last || last.per !== c.count) stsc.push({ first: i + 1, per: c.count });
    });
    b.fullBox('stsc', 0, 0, () => {
      b.u32(stsc.length);
      for (const e of stsc) {
        b.u32(e.first);
        b.u32(e.per);
        b.u32(1); // sample_description_index
      }
    });

    // stsz
    b.fullBox('stsz', 0, 0, () => {
      b.u32(0); // 逐样本给出，不用统一大小
      b.u32(samples.length);
      for (const s of samples) b.u32(s.size);
    });

    // stco
    b.fullBox('stco', 0, 0, () => {
      b.u32(chunks.length);
      for (const c of chunks) b.u32(c.offset);
    });
  });

  return b.view();
}

function buildMoov(plan, baseOffset) {
  const b = new ByteWriter(32768);
  const video = plan.video;
  const audio = plan.audio;
  const totalDur = plan.durationMovieTs;
  if (!video && !audio) throw new Error('没有可写出的轨道');

  b.box('moov', () => {
    b.fullBox('mvhd', 0, 0, () => {
      b.u32(0);
      b.u32(0);
      b.u32(MOVIE_TIMESCALE);
      b.u32(totalDur);
      b.u32(0x00010000);
      b.u16(0x0100);
      b.zeros(2);
      b.zeros(8);
      for (const v of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) b.u32(v);
      b.zeros(24);
      b.u32(audio ? 3 : 2); // next_track_ID
    });

    const writeTrak = (t, newId) => {
      b.box('trak', () => {
        b.bytes(patchTkhd(t.buf, t.tkhdBox, newId, Math.round((t.durationTrackTs / t.timescale) * MOVIE_TIMESCALE)));
        b.box('mdia', () => {
          b.bytes(patchMdhd(t.buf, t.mdhdBox, t.durationTrackTs));
          b.bytes(sliceBox(t.buf, t.hdlrBox));
          b.box('minf', () => {
            const mediaHeader = t.handler === 'vide' ? t.vmhdBox : t.smhdBox;
            if (mediaHeader) b.bytes(sliceBox(t.buf, mediaHeader));
            b.bytes(sliceBox(t.buf, t.dinfBox));
            b.bytes(buildStbl(t, { baseOffset }));
          });
        });
      });
    };

    if (video) writeTrak(video, 1);
    if (audio) writeTrak(audio, video ? 2 : 1);
  });

  return b.view();
}

function buildFtyp() {
  const b = new ByteWriter(32);
  b.box('ftyp', () => {
    b.ascii('isom');
    b.u32(0x200);
    b.ascii('isom');
    b.ascii('iso2');
    b.ascii('avc1');
    b.ascii('mp41');
  });
  return b.view();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function pickTrack(index, handler) {
  if (!index) return null;
  return index.tracks.find((t) => t.handler === handler && t.samples.length) || null;
}

/**
 * 合并两个 MP4（一个出画面、一个出声音）。
 *
 * @param {{
 *   video: {size:number, slice?:Function, read?:Function},
 *   audio: {size:number, slice?:Function, read?:Function},
 *   sink: {write:(b:Uint8Array)=>Promise<void>, close:()=>Promise<void>},
 *   onProgress?: (ratio:number, text:string) => void
 * }} opts
 * @returns {Promise<{size:number, videoSamples:number, audioSamples:number, duration:number}>}
 */
export async function mergeMp4Tracks(opts) {
  const { video, audio, sink, onProgress } = opts;

  const vIndex = await loadMp4Index(video);
  const aIndex = await loadMp4Index(audio);
  if (!vIndex) throw new Error('视频文件结构无法识别');
  if (!aIndex) throw new Error('音频文件结构无法识别');
  if (vIndex.fragmented) throw new Error('视频是分片流（fMP4），不能直接合并');
  if (aIndex.fragmented) throw new Error('音频是分片流（fMP4），不能直接合并');

  const vTrack = pickTrack(vIndex, 'vide');
  const aTrack = pickTrack(aIndex, 'soun');
  if (!vTrack) throw new Error('视频文件里没有可用的视频轨');
  if (!aTrack) throw new Error('音频文件里没有可用的音频轨');

  // 补齐后面要原样搬运的 box
  const vTop = boxes(vIndex.buf, 0, vIndex.buf.length).find((b) => b.type === 'moov');
  const aTop = boxes(aIndex.buf, 0, aIndex.buf.length).find((b) => b.type === 'moov');
  const collect = (buf, moov, track, handler) => {
    const trak = boxes(buf, moov.body, moov.end).find(
      (b) => b.type === 'trak' && (() => {
        const mdia = child(buf, b, 'mdia');
        const hdlr = mdia && child(buf, mdia, 'hdlr');
        return hdlr && fourcc(buf, hdlr.body + 8) === handler;
      })()
    );
    if (!trak) return null;
    const mdia = child(buf, trak, 'mdia');
    const minf = child(buf, mdia, 'minf');
    return {
      tkhdBox: child(buf, trak, 'tkhd'),
      mdhdBox: child(buf, mdia, 'mdhd'),
      hdlrBox: child(buf, mdia, 'hdlr'),
      vmhdBox: child(buf, minf, 'vmhd'),
      smhdBox: child(buf, minf, 'smhd'),
      dinfBox: child(buf, minf, 'dinf')
    };
  };

  const vBoxes = collect(vIndex.buf, vTop, vTrack, 'vide');
  const aBoxes = collect(aIndex.buf, aTop, aTrack, 'soun');
  if (!vBoxes || !vBoxes.dinfBox || !vBoxes.tkhdBox) throw new Error('视频轨缺少必要的容器信息');
  if (!aBoxes || !aBoxes.dinfBox || !aBoxes.tkhdBox) throw new Error('音频轨缺少必要的容器信息');

  // stsd 必须按 handler 找到真正那条 trak：一个文件里可能有多条轨
  const findStsd = (buf, moov, handler) => {
    for (const trak of boxes(buf, moov.body, moov.end)) {
      if (trak.type !== 'trak') continue;
      const mdia = child(buf, trak, 'mdia');
      const hdlr = mdia && child(buf, mdia, 'hdlr');
      if (!hdlr || fourcc(buf, hdlr.body + 8) !== handler) continue;
      const minf = child(buf, mdia, 'minf');
      const stbl = minf && child(buf, minf, 'stbl');
      const stsd = stbl && child(buf, stbl, 'stsd');
      if (stsd) return stsd;
    }
    return null;
  };
  const vs = findStsd(vIndex.buf, vTop, 'vide');
  const as = findStsd(aIndex.buf, aTop, 'soun');
  if (!vs) throw new Error('视频轨缺少 stsd');
  if (!as) throw new Error('音频轨缺少 stsd');

  // ---- 组装成可写入的轨道描述 ----
  const readyV = {
    buf: vIndex.buf,
    ...vBoxes,
    stsdBytes: sliceBox(vIndex.buf, vs),
    handler: 'vide',
    timescale: vTrack.timescale,
    samples: vTrack.samples
  };
  const readyA = {
    buf: aIndex.buf,
    ...aBoxes,
    stsdBytes: sliceBox(aIndex.buf, as),
    handler: 'soun',
    timescale: aTrack.timescale,
    samples: aTrack.samples
  };

  const { plan, chunks } = buildPlan(readyV, readyA);
  return writePlan(plan, chunks, { v: video, a: audio }, sink, onProgress);
}

/**
 * 两条轨的样本按时间交错、切成物理连续的 chunk，并算出每个 chunk 在 mdat 里的
 * 相对偏移。返回的 plan 可以直接交给 buildMoov。
 *
 * chunk 必须物理连续，因为写数据时是按 chunk 做一次 Range 读的：源文件里
 * 视频 chunk 和音频 chunk 是交错的，跨 chunk 合并会把别人的字节读进来。
 */
function buildPlan(vTrack, aTrack) {
  const vSamples = vTrack ? vTrack.samples : [];
  const aSamples = aTrack ? aTrack.samples : [];

  const merged = [];
  let vi = 0;
  let ai = 0;
  while (vi < vSamples.length || ai < aSamples.length) {
    const vt = vi < vSamples.length ? vSamples[vi].dts / vTrack.timescale : Infinity;
    const at = ai < aSamples.length ? aSamples[ai].dts / aTrack.timescale : Infinity;
    if (vt <= at) merged.push({ kind: 'v', s: vSamples[vi++] });
    else merged.push({ kind: 'a', s: aSamples[ai++] });
  }

  const groups = [];
  for (const item of merged) {
    const last = groups[groups.length - 1];
    const prev = last && last.items.length ? last.items[last.items.length - 1] : null;
    const contiguous = prev && item.s.offset === prev.offset + prev.size;
    if (last && last.kind === item.kind && contiguous) {
      last.items.push(item.s);
      last.bytes += item.s.size;
    } else {
      groups.push({ kind: item.kind, items: [item.s], bytes: item.s.size });
    }
  }

  let dataSize = 0;
  for (const g of groups) {
    g.dataOffset = dataSize;
    dataSize += g.bytes;
  }

  const vChunks = [];
  const aChunks = [];
  for (const g of groups) {
    if (g.kind === 'v') vChunks.push({ count: g.items.length, rel: g.dataOffset });
    else aChunks.push({ count: g.items.length, rel: g.dataOffset });
  }

  const vDur = vTrack ? lastDuration(vSamples, vTrack.timescale) : 0;
  const aDur = aTrack ? lastDuration(aSamples, aTrack.timescale) : 0;

  const plan = {
    video: vTrack ? { ...vTrack, chunks: vChunks, durationTrackTs: Math.round(vDur * vTrack.timescale) } : null,
    audio: aTrack ? { ...aTrack, chunks: aChunks, durationTrackTs: Math.round(aDur * aTrack.timescale) } : null,
    durationMovieTs: Math.round(Math.max(vDur, aDur) * MOVIE_TIMESCALE),
    dataSize
  };
  return { plan, chunks: groups };
}

/** 按 plan 写出 ftyp + moov + mdat（数据按 chunk 从源读取） */
async function writePlan(plan, chunks, sources, sink, onProgress) {
  const zero = (list) => list.map((c) => ({ ...c, offset: 0 }));
  const ftyp = buildFtyp();

  // 第一遍只为拿到 moov 长度（chunk 偏移先填 0）
  const probeMoov = buildMoov(
    {
      video: plan.video ? { ...plan.video, chunks: zero(plan.video.chunks) } : null,
      audio: plan.audio ? { ...plan.audio, chunks: zero(plan.audio.chunks) } : null,
      durationMovieTs: plan.durationMovieTs
    },
    0
  );
  const headLen = ftyp.length + probeMoov.length + 8;

  // 第二遍：chunk 偏移 = headLen + mdat 内相对偏移
  const stco = (list) =>
    list.map((c) => {
      const abs = headLen + c.rel;
      if (abs > 0xffffffff) throw new Error('输出超过 4GB，超出 32 位 stco 限制');
      return { ...c, offset: abs };
    });

  const moov = buildMoov(
    {
      video: plan.video ? { ...plan.video, chunks: stco(plan.video.chunks) } : null,
      audio: plan.audio ? { ...plan.audio, chunks: stco(plan.audio.chunks) } : null,
      durationMovieTs: plan.durationMovieTs
    },
    headLen
  );
  if (ftyp.length + moov.length + 8 !== headLen) {
    throw new Error('moov 长度不稳定，无法确定 chunk 偏移');
  }

  const head = new Uint8Array(headLen);
  head.set(ftyp, 0);
  head.set(moov, ftyp.length);
  const mdatAt = ftyp.length + moov.length;
  new DataView(head.buffer).setUint32(mdatAt, plan.dataSize + 8);
  head[mdatAt + 4] = 0x6d;
  head[mdatAt + 5] = 0x64;
  head[mdatAt + 6] = 0x61;
  head[mdatAt + 7] = 0x74;
  await sink.write(head);

  let written = 0;
  let lastTick = 0;
  for (const g of chunks) {
    const src = sources[g.kind];
    const first = g.items[0];
    const last = g.items[g.items.length - 1];
    const bytes = await readRange(src, first.offset, last.offset + last.size);
    if (bytes.length !== g.bytes) {
      throw new Error(`读取${g.kind === 'v' ? '视频' : '音频'}数据时长度不符，源文件可能不完整`);
    }
    await sink.write(bytes);
    written += bytes.length;

    const now = Date.now();
    if (onProgress && now - lastTick > 200) {
      lastTick = now;
      onProgress(written / Math.max(1, plan.dataSize), `合成 ${(written / 1048576).toFixed(1)}MB`);
    }
  }

  await sink.close();

  return {
    size: headLen + plan.dataSize,
    videoSamples: plan.video ? plan.video.samples.length : 0,
    audioSamples: plan.audio ? plan.audio.samples.length : 0,
    duration: plan.durationMovieTs / MOVIE_TIMESCALE
  };
}

function lastDuration(samples, timescale) {
  if (!samples.length) return 0;
  const last = samples[samples.length - 1];
  const prev = samples.length > 1 ? samples[samples.length - 2] : last;
  const step = Math.max(1, last.dts - prev.dts);
  return (last.dts + step) / timescale;
}

/**
 * 快速判断一个 MP4 头部是不是「分片流」（moov 里没有样本表、数据在 moof 里）。
 * 分片流不能当独立视频下载，也不能参与合并。
 */
export function isFragmented(buf) {
  const top = boxes(buf, 0, buf.length);
  if (top.some((b) => b.type === 'moof')) return true;
  const moov = top.find((b) => b.type === 'moov');
  if (moov && child(buf, moov, 'mvex')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// fMP4（分片流）→ 标准 MP4
// ---------------------------------------------------------------------------

/** 顺序遍历顶层 box 的小工具：每次只读 16 字节头，不把整个文件读进内存 */
async function topBoxAt(src, at) {
  if (at + 8 > src.size) return null;
  const head = await readRange(src, at, Math.min(at + 16, src.size));
  if (head.length < 8) return null;
  let size = u32(head, 0);
  let header = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = u64(head, 8);
    header = 16;
  } else if (size === 0) {
    size = src.size - at;
  }
  if (size < header) return null;
  const type = fourcc(head, 4);
  return { type, at, size, header, body: at + header, end: at + size };
}

/**
 * 把 fMP4（moov + 一串 moof/mdat）的样本表展开出来。
 *
 * 和普通 MP4 的区别：`stbl` 里没有 `stsz`/`stco`，每个 `moof > traf > trun`
 * 自带一批样本的大小、时长和相对偏移；默认值在 `tfhd` / `trex` 里。
 *
 * @returns {{tracks: object[], duration:number} | null}
 */
export async function loadFmp4Index(src) {
  const headLen = Math.min(src.size, HEAD_PROBE);
  let buf = await readRange(src, 0, headLen);
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;
  if (moov.at + moov.size > buf.length) {
    buf = await readRange(src, 0, moov.at + moov.size);
  }

  const moovTop = boxes(buf, 0, buf.length).find((b) => b.type === 'moov');
  if (!moovTop) return null;

  // ---- trex 默认值 ----
  const trex = new Map();
  const mvex = child(buf, moovTop, 'mvex');
  if (mvex) {
    for (const b of boxes(buf, mvex.body, mvex.end)) {
      if (b.type !== 'trex') continue;
      trex.set(u32(buf, b.body + 4), {
        duration: u32(buf, b.body + 12),
        size: u32(buf, b.body + 16),
        flags: u32(buf, b.body + 20)
      });
    }
  }

  // ---- 各轨的容器信息 ----
  const tracks = [];
  for (const trak of boxes(buf, moovTop.body, moovTop.end)) {
    if (trak.type !== 'trak') continue;
    const t = readTrak(buf, trak);
    if (!t || (!VIDEO_HANDLERS.has(t.handler) && !AUDIO_HANDLERS.has(t.handler))) continue;
    const mdia = child(buf, trak, 'mdia');
    const minf = child(buf, mdia, 'minf');
    const stbl = child(buf, minf, 'stbl');
    const stsd = child(buf, stbl, 'stsd');
    tracks.push({
      buf,
      id: t.id,
      handler: t.handler,
      codec: t.codec,
      timescale: t.timescale,
      stsdBytes: stsd ? sliceBox(buf, stsd) : null,
      tkhdBox: child(buf, trak, 'tkhd'),
      mdhdBox: child(buf, mdia, 'mdhd'),
      hdlrBox: child(buf, mdia, 'hdlr'),
      vmhdBox: child(buf, minf, 'vmhd'),
      smhdBox: child(buf, minf, 'smhd'),
      dinfBox: child(buf, minf, 'dinf'),
      samples: []
    });
  }
  if (!tracks.length) return null;

  const byId = new Map(tracks.map((t) => [t.id, t]));
  // 每个轨道的下一个预计 dts（tfdt 缺失时才用得上）
  const cursor = new Map();

  // ---- 遍历所有 moof ----
  let at = moovTop.at + moovTop.size;
  for (let guard = 0; guard < 200000 && at + 8 <= src.size; guard += 1) {
    const box = await topBoxAt(src, at);
    if (!box) break;
    at = box.end;

    if (box.type !== 'moof') continue;
    const moofBuf = await readRange(src, box.at, box.end);
    const moofBox = boxes(moofBuf, 0, moofBuf.length).find((b) => b.type === 'moof');
    if (!moofBox) continue;

    for (const traf of boxes(moofBuf, moofBox.body, moofBox.end)) {
      if (traf.type !== 'traf') continue;

      let tfhd = null;
      let tfdt = null;
      const truns = [];
      for (const b of boxes(moofBuf, traf.body, traf.end)) {
        if (b.type === 'tfhd') tfhd = b;
        else if (b.type === 'tfdt') tfdt = b;
        else if (b.type === 'trun') truns.push(b);
      }
      if (!tfhd) continue;

      const tfhdFlags = u32(moofBuf, tfhd.body) & 0xffffff;
      let p = tfhd.body + 4;
      const trackId = u32(moofBuf, p);
      p += 4;
      let baseDataOffset = null;
      if (tfhdFlags & 0x000001) {
        baseDataOffset = u64(moofBuf, p);
        p += 8;
      }
      if (tfhdFlags & 0x000002) p += 4; // sample_description_index
      let defDuration = trex.get(trackId)?.duration || 0;
      let defSize = trex.get(trackId)?.size || 0;
      if (tfhdFlags & 0x000008) {
        defDuration = u32(moofBuf, p);
        p += 4;
      }
      if (tfhdFlags & 0x000010) {
        defSize = u32(moofBuf, p);
        p += 4;
      }

      const track = byId.get(trackId);
      if (!track) continue;

      let dts = cursor.get(trackId);
      if (tfdt) {
        const v = moofBuf[tfdt.body];
        const base = v === 1 ? u64(moofBuf, tfdt.body + 4) : u32(moofBuf, tfdt.body + 4);
        if (dts === undefined || base > dts) dts = base;
      }
      if (dts === undefined) dts = 0;

      const moofStart = box.at;
      let dataCursor = null;

      for (const trun of truns) {
        const flags = u32(moofBuf, trun.body) & 0xffffff;
        const count = u32(moofBuf, trun.body + 4);
        let q = trun.body + 8;

        if (flags & 0x000001) {
          const off = i32(moofBuf, q);
          q += 4;
          dataCursor = (baseDataOffset != null ? baseDataOffset : moofStart) + off;
        } else if (dataCursor == null) {
          // 没有 data_offset：数据紧跟在 moof 之后
          dataCursor = baseDataOffset != null ? baseDataOffset : box.end;
        }

        let firstSampleFlags = null;
        if (flags & 0x000004) {
          firstSampleFlags = u32(moofBuf, q);
          q += 4;
        }

        for (let i = 0; i < count; i += 1) {
          const dur = flags & 0x000100 ? u32(moofBuf, q) : defDuration;
          if (flags & 0x000100) q += 4;
          const size = flags & 0x000200 ? u32(moofBuf, q) : defSize;
          if (flags & 0x000200) q += 4;
          const sflags = flags & 0x000400 ? u32(moofBuf, q) : i === 0 && firstSampleFlags != null ? firstSampleFlags : 0;
          if (flags & 0x000400) q += 4;
          const ctsOff = flags & 0x000800 ? i32(moofBuf, q) : 0;
          if (flags & 0x000800) q += 4;

          if (!size) break; // 样本表坏了，后面的也不可信

          track.samples.push({
            size,
            dts,
            cts: dts + ctsOff,
            // sample_is_non_sync_sample（bit 16）为 0 才是关键帧；拿不到 flags 时按关键帧处理
            key: sflags ? (sflags & 0x00010000) === 0 : true,
            offset: dataCursor
          });
          dataCursor += size;
          dts += Math.max(0, dur);
        }
      }
      cursor.set(trackId, dts);
    }
  }

  if (!tracks.some((t) => t.samples.length)) return null;

  let duration = 0;
  const mvhd = child(buf, moovTop, 'mvhd');
  if (mvhd) {
    const v = buf[mvhd.body];
    const ts = v === 1 ? u32(buf, mvhd.body + 20) : u32(buf, mvhd.body + 12);
    const du = v === 1 ? u64(buf, mvhd.body + 24) : u32(buf, mvhd.body + 16);
    duration = ts ? du / ts : 0;
  }

  return { tracks: tracks.filter((t) => t.samples.length), declaredDuration: duration };
}

/**
 * 把一条 fMP4（分片流）转成普通的、moov 前置的 MP4。
 *
 * 抖音现在不少页面走 MSE + fMP4，嗅探到的单条 `m4s` 就是这样：能完整下载，
 * 但 `<video src>` 和多数播放器不认，必须把样本表从 `moof` 里搬进 `stbl`。
 *
 * @returns {Promise<{size:number, videoSamples:number, audioSamples:number, duration:number, declaredDuration:number}>}
 */
export async function remuxFragmentedMp4({ src, sink, onProgress }) {
  const index = await loadFmp4Index(src);
  if (!index) throw new Error('这个分片流里没有可用的视频帧');

  const video = index.tracks.find((t) => t.handler === 'vide') || null;
  const audio = index.tracks.find((t) => t.handler === 'soun') || null;
  if (!video && !audio) throw new Error('这个分片流里没有可用的轨道');
  for (const t of [video, audio]) {
    if (t && (!t.stsdBytes || !t.tkhdBox || !t.mdhdBox || !t.dinfBox)) {
      throw new Error('分片流缺少必要的容器信息，无法转换');
    }
  }

  const { plan, chunks } = buildPlan(video, audio);
  const result = await writePlan(plan, chunks, { v: src, a: src }, sink, onProgress);
  return { ...result, declaredDuration: index.declaredDuration };
}
