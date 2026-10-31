/**
 * MP4（progressive）流式封装。
 *
 * 不重编码：把 tsdemux 解出来的 H.264 / AAC 样本按顺序写进 mdat，
 * 元数据（每帧大小、时间戳、chunk 偏移）只留在内存里，最后拼出 moov。
 *
 * 内存模型：mdat 通过 sink 边生成边落盘，进程内常驻的只有
 * 「每帧 20 字节左右的元数据」+ 几百 KB 的 moov，与视频总大小无关。
 * 这就是为什么能处理 1.5GB 而 ffmpeg.wasm 在 900MB 就 OOM。
 *
 * moov 要写在 mdat 前面，但 stco 里的偏移又依赖 moov 自身长度 —— 靠「构造两遍」
 * 解决：第一遍用 0 偏移量出长度，第二遍用真实基准重建。stco 项数不变、数值定长，
 * 所以两遍长度必然一致。
 */

const MOVIE_TIMESCALE = 1000;
const UNITY_MATRIX = [
  0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000
];

// ---------------------------------------------------------------------------
// 字节写入器
// ---------------------------------------------------------------------------

class Bytes {
  constructor(initial = 4096) {
    this.buf = new Uint8Array(initial);
    this.len = 0;
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v) {
    this.ensure(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  i16(v) {
    this.u16(v < 0 ? v + 0x10000 : v);
  }

  u24(v) {
    this.u8(v >>> 16);
    this.u8(v >>> 8);
    this.u8(v);
  }

  u32(v) {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  i32(v) {
    this.u32(v < 0 ? v + 0x100000000 : v);
  }

  zeros(n) {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
  }

  ascii(str) {
    this.ensure(str.length);
    for (let i = 0; i < str.length; i += 1) this.buf[this.len++] = str.charCodeAt(i) & 0xff;
  }

  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }

  patchU32(at, v) {
    this.buf[at] = (v >>> 24) & 0xff;
    this.buf[at + 1] = (v >>> 16) & 0xff;
    this.buf[at + 2] = (v >>> 8) & 0xff;
    this.buf[at + 3] = v & 0xff;
  }

  /** 写一个 box，自动回填长度 */
  box(type, fn) {
    const start = this.len;
    this.u32(0);
    this.ascii(type);
    fn();
    this.patchU32(start, this.len - start);
  }

  /** 完整版 box：version + flags + body */
  fullBox(type, version, flags, fn) {
    this.box(type, () => {
      this.u8(version);
      this.u24(flags);
      fn();
    });
  }

  view() {
    return this.buf.subarray(0, this.len);
  }
}

// ---------------------------------------------------------------------------
// 描述符（esds 用）
// ---------------------------------------------------------------------------

function descriptor(tag, payload) {
  const out = new Uint8Array(2 + payload.length);
  out[0] = tag;
  out[1] = payload.length;
  out.set(payload, 2);
  return out;
}

function buildEsds(asc, sampleRate, channels) {
  const dsi = descriptor(0x05, asc);
  const dcd = new Bytes(64);
  dcd.u8(0x40); // objectTypeIndication: Audio ISO/IEC 14496-3
  dcd.u8(0x15); // streamType=Audio(5) << 2 | reserved
  dcd.u24(sampleRate >= 48000 ? sampleRate * 2 : 128 * 1024); // bufferSizeDB
  dcd.u32(128000); // maxBitrate
  dcd.u32(128000); // avgBitrate
  dcd.bytes(dsi);

  const es = new Bytes(96);
  es.u16(1); // ES_ID
  es.u8(0); // flags
  es.bytes(descriptor(0x04, dcd.view()));
  es.bytes(descriptor(0x06, new Uint8Array([0x02]))); // SLConfig

  const b = new Bytes(128);
  b.fullBox('esds', 0, 0, () => {
    b.bytes(descriptor(0x03, es.view()));
  });
  return b.view();
}

// ---------------------------------------------------------------------------
// 封装器
// ---------------------------------------------------------------------------

export class Mp4Muxer {
  /**
   * @param {{ write: (bytes: Uint8Array) => Promise<void>, close: () => Promise<void> }} sink
   */
  constructor(sink, opts = {}) {
    if (!sink) throw new Error('Mp4Muxer 需要一个写入目标');
    this.sink = sink;
    this.flushThreshold = opts.flushThreshold || 4 * 1024 * 1024;

    this.pending = [];
    this.pendingBytes = 0;
    this.dataSize = 0; // 已经（含待写）交给 mdat 的字节数
    this.lastTrack = '';

    this.video = {
      timescale: opts.videoTimescale || 90000,
      samples: [],
      chunks: [],
      lastDts: null,
      lastDelta: 0,
      baseDts: undefined
    };
    this.audio = {
      timescale: opts.audioTimescale || 48000,
      samples: [],
      chunks: [],
      lastDts: null,
      lastDelta: 0,
      baseDts: undefined
    };

    this.videoConfig = null;
    this.audioConfig = null;
    this.closed = false;
  }

  setVideoConfig(cfg) {
    if (!cfg || !cfg.sps || !cfg.pps) throw new Error('视频缺少 SPS/PPS，无法封装');
    this.videoConfig = {
      width: cfg.width || 0,
      height: cfg.height || 0,
      sps: cfg.sps,
      pps: cfg.pps
    };
    if (cfg.timescale) this.video.timescale = cfg.timescale;
  }

  setAudioConfig(cfg) {
    if (!cfg || !cfg.asc) return;
    this.audioConfig = {
      sampleRate: cfg.sampleRate || 48000,
      channels: cfg.channels || 2,
      asc: cfg.asc
    };
    this.audio.timescale = cfg.sampleRate || 48000;
  }

  /** 同步入队；数据攒够阈值后由调用方 flush() 触发落盘 */
  addSample(sample) {
    if (this.closed) throw new Error('封装器已关闭');
    const track = sample.track === 'audio' ? this.audio : this.video;
    const name = sample.track === 'audio' ? 'audio' : 'video';

    let dts = sample.dts;
    let cts = sample.cts === undefined ? dts : sample.cts;
    if (dts === null || dts === undefined || !Number.isFinite(dts)) {
      dts = track.lastDts === null ? 0 : track.lastDts + track.lastDelta;
    }
    // 时间戳必须单调：个别流有回退或重复，纠正成「上一帧 + 一个步长」
    if (track.lastDts !== null && dts <= track.lastDts) {
      dts = track.lastDts + (track.lastDelta || 1);
    }
    if (cts === null || cts === undefined || !Number.isFinite(cts)) cts = dts;

    if (track.lastDts !== null) {
      const delta = dts - track.lastDts;
      if (delta > 0) track.lastDelta = delta;
    }
    track.lastDts = dts;

    // 基准必须是「第一帧的原始时间戳」，且只取一次。
    // 早期版本取 samples[0].dts（已归一化成 0），导致第二帧起减了个寂寞，
    // 写进 stts 的是原始 90kHz 时间戳，首帧间隔变成 1.6 秒。
    if (track.baseDts === undefined) track.baseDts = dts;
    const size = sample.data.length;

    track.samples.push({
      size,
      dts: dts - track.baseDts,
      cts: cts - track.baseDts,
      key: Boolean(sample.key)
    });

    // 同一个 track 连续写入就并进同一个 chunk；切换 track 就开新 chunk
    const lastChunk = track.chunks[track.chunks.length - 1];
    if (this.lastTrack === name && lastChunk) {
      lastChunk.count += 1;
    } else {
      track.chunks.push({ offset: this.dataSize, count: 1 });
    }
    this.lastTrack = name;

    this.dataSize += size;
    this.pending.push(sample.data);
    this.pendingBytes += size;
  }

  async flush() {
    if (!this.pendingBytes) return;
    const merged = concatBytes(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    await this.sink.write(merged);
  }

  /** 第一个样本的时间戳（用于跨轨对齐提示） */
  firstDts(track) {
    const t = track === 'audio' ? this.audio : this.video;
    return t.samples.length ? t.samples[0].dts : 0;
  }

  /**
   * 用帧率重建均匀时间戳。
   *
   * TS 里 PES 的 PTS/DTS 经常不可靠：HLS 分片常见帧间隔忽大忽小
   * （实测有 18192 / 1808 混排的流，ffmpeg 自己播放时也是按帧率重建的）。
   * 照搬原值会让 MP4 变成时基不稳的 VFR，播放器量化后出现重复时间戳，
   * 总时长也会漂移。
   *
   * 做法：用总跨度估出帧率，吸附到标准帧率（23.976/24/25/29.97/30/50/60）
   * 再统一排布。只有真的存在长停顿（间隔超过平均 2.5 倍，意味丢帧或分段间隙）
   * 时才尊重原始时间戳。
   */
  normalizeTimestamps(track) {
    const s = track.samples;
    if (s.length < 4) return;

    const offsets = s.map((x) => x.cts - x.dts);
    const span = s[s.length - 1].dts - s[0].dts;
    if (!(span > 0)) return;

    const avg = span / (s.length - 1);
    if (!(avg > 0)) return;

    // 零星的长间隔是真停顿（丢帧、分段间空隙），这种要保留原时间戳。
    // 但周期性出现的长间隔属于「时间戳本身不可靠」（实测流里每 9~10 帧就跳一次），
    // 按占比区分：超过 5% 就认为是系统性问题，照样重建。
    let bigGaps = 0;
    for (let i = 1; i < s.length; i += 1) {
      if (s[i].dts - s[i - 1].dts > avg * 2.5) bigGaps += 1;
    }
    if (bigGaps > 0 && bigGaps <= (s.length - 1) * 0.05) return;

    const fps = track.timescale / avg;
    const standard = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
    let step = Math.round(avg);
    let best = 0;
    let bestDiff = 0.05; // 只接受 5% 以内的偏差
    for (const f of standard) {
      const diff = Math.abs(f - fps) / f;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = f;
      }
    }
    if (best) step = Math.round(track.timescale / best);
    if (!(step > 0)) return;

    for (let i = 0; i < s.length; i += 1) {
      s[i].dts = i * step;
      s[i].cts = s[i].dts + offsets[i];
    }
    track.lastDelta = step;
  }

  /**
   * 收尾：落盘剩余数据、生成 ftyp/moov/mdat 头。
   * @returns {Promise<{head: Uint8Array, dataSize: number, video: number, audio: number}>}
   */
  async finish() {
    await this.flush();
    await this.sink.close();
    this.closed = true;

    if (!this.videoConfig) throw new Error('没有视频轨，无法生成 MP4');
    if (!this.video.samples.length) throw new Error('没有解出任何视频帧');

    this.normalizeTimestamps(this.video);
    if (this.audio.samples.length) this.normalizeTimestamps(this.audio);

    const ftyp = buildFtyp();
    let moov = this.buildMoov(0);
    const headLen = ftyp.length + moov.length + 8;
    moov = this.buildMoov(headLen);
    if (ftyp.length + moov.length + 8 !== headLen) {
      // 理论上不会发生：stco 项数固定、数值定长
      throw new Error('moov 长度不稳定，无法确定 chunk 偏移');
    }

    const mdatHeader = new Uint8Array(8);
    const mdatSize = this.dataSize + 8;
    if (mdatSize > 0xffffffff) throw new Error('单个 MP4 超过 4GB，超出 32 位 box 限制');
    new DataView(mdatHeader.buffer).setUint32(0, mdatSize);
    mdatHeader[4] = 0x6d; // m
    mdatHeader[5] = 0x64; // d
    mdatHeader[6] = 0x61; // a
    mdatHeader[7] = 0x74; // t

    const head = new Uint8Array(headLen);
    head.set(ftyp, 0);
    head.set(moov, ftyp.length);
    head.set(mdatHeader, ftyp.length + moov.length);

    return {
      head,
      dataSize: this.dataSize,
      video: this.video.samples.length,
      audio: this.audio.samples.length
    };
  }

  trackDuration(t) {
    if (!t.samples.length) return 0;
    const last = t.samples[t.samples.length - 1];
    const step = t.lastDelta || (t === this.video ? Math.round(t.timescale / 25) : 1024);
    return last.dts + step;
  }

  buildMoov(baseOffset) {
    const b = new Bytes(16384);
    const hasAudio = this.audioConfig && this.audio.samples.length > 0;
    const vDur = this.trackDuration(this.video);
    const aDur = hasAudio ? this.trackDuration(this.audio) : 0;
    const movieDur = Math.round(
      Math.max(vDur / this.video.timescale, hasAudio ? aDur / this.audio.timescale : 0) * MOVIE_TIMESCALE
    );

    b.box('moov', () => {
      // ---- mvhd ----
      b.fullBox('mvhd', 0, 0, () => {
        b.u32(0); // creation
        b.u32(0); // modification
        b.u32(MOVIE_TIMESCALE);
        b.u32(movieDur);
        b.u32(0x00010000); // rate 1.0
        b.u16(0x0100); // volume 1.0
        b.zeros(2);
        b.zeros(8);
        for (const v of UNITY_MATRIX) b.u32(v);
        b.zeros(24);
        b.u32(hasAudio ? 3 : 2); // next_track_ID
      });

      // ---- 视频轨 ----
      this.writeTrack(b, {
        id: 1,
        kind: 'vide',
        timescale: this.video.timescale,
        duration: vDur,
        movieDur: Math.round((vDur / this.video.timescale) * MOVIE_TIMESCALE),
        volume: 0,
        width: this.videoConfig.width,
        height: this.videoConfig.height,
        sampleEntry: () => this.writeAvc1(b),
        track: this.video,
        baseOffset
      });

      // ---- 音频轨 ----
      if (hasAudio) {
        this.writeTrack(b, {
          id: 2,
          kind: 'soun',
          timescale: this.audio.timescale,
          duration: aDur,
          movieDur: Math.round((aDur / this.audio.timescale) * MOVIE_TIMESCALE),
          volume: 0x0100,
          width: 0,
          height: 0,
          sampleEntry: () => this.writeMp4a(b),
          track: this.audio,
          baseOffset
        });
      }
    });
    return b.view();
  }

  writeTrack(b, cfg) {
    const { track } = cfg;
    b.box('trak', () => {
      b.fullBox('tkhd', 0, 3, () => {
        b.u32(0);
        b.u32(0);
        b.u32(cfg.id);
        b.u32(0);
        b.u32(cfg.movieDur);
        b.zeros(8);
        b.u16(0); // layer
        b.u16(0); // alternate_group
        b.u16(cfg.volume);
        b.u16(0);
        for (const v of UNITY_MATRIX) b.u32(v);
        b.u32(cfg.width * 0x10000);
        b.u32(cfg.height * 0x10000);
      });

      b.box('mdia', () => {
        b.fullBox('mdhd', 0, 0, () => {
          b.u32(0);
          b.u32(0);
          b.u32(cfg.timescale);
          b.u32(cfg.duration);
          b.u16(0x55c4); // language: und
          b.u16(0);
        });

        b.fullBox('hdlr', 0, 0, () => {
          b.u32(0);
          b.ascii(cfg.kind);
          b.zeros(12);
          b.ascii(cfg.kind === 'vide' ? 'VideoHandler' : 'SoundHandler');
          b.u8(0);
        });

        b.box('minf', () => {
          if (cfg.kind === 'vide') {
            b.fullBox('vmhd', 0, 1, () => {
              b.u16(0);
              b.zeros(6);
            });
          } else {
            b.fullBox('smhd', 0, 0, () => {
              b.u16(0);
              b.u16(0);
            });
          }

          b.box('dinf', () => {
            b.fullBox('dref', 0, 0, () => {
              b.u32(1);
              b.fullBox('url ', 0, 1, () => {});
            });
          });

          b.box('stbl', () => {
            this.writeStbl(b, cfg);
          });
        });
      });
    });
  }

  writeStbl(b, cfg) {
    const { track } = cfg;

    // ---- stsd ----
    b.fullBox('stsd', 0, 0, () => {
      b.u32(1);
      cfg.sampleEntry();
    });

    // ---- stts ----
    const deltas = [];
    for (let i = 0; i < track.samples.length; i += 1) {
      const cur = track.samples[i];
      const next = track.samples[i + 1];
      const d = next ? next.dts - cur.dts : track.lastDelta || 1;
      deltas.push(d > 0 ? d : 1);
    }
    const sttsRuns = runLength(deltas);
    b.fullBox('stts', 0, 0, () => {
      b.u32(sttsRuns.length);
      for (const run of sttsRuns) {
        b.u32(run.count);
        b.u32(run.value);
      }
    });

    // ---- ctts（只有存在显示时间偏移时才写）----
    const offsets = track.samples.map((s) => s.cts - s.dts);
    const hasOffset = offsets.some((o) => o !== 0);
    if (hasOffset) {
      const signed = offsets.some((o) => o < 0);
      const runs = runLength(offsets);
      b.fullBox('ctts', signed ? 1 : 0, 0, () => {
        b.u32(runs.length);
        for (const run of runs) {
          b.u32(run.count);
          if (signed) b.i32(run.value);
          else b.u32(run.value);
        }
      });
    }

    // ---- stss（视频才有意义；全是关键帧时省略）----
    if (cfg.kind === 'vide') {
      const keys = [];
      track.samples.forEach((s, i) => {
        if (s.key) keys.push(i + 1);
      });
      if (keys.length && keys.length < track.samples.length) {
        b.fullBox('stss', 0, 0, () => {
          b.u32(keys.length);
          for (const k of keys) b.u32(k);
        });
      }
    }

    // ---- stsc ----
    const scRuns = runLength(track.chunks.map((c) => c.count));
    b.fullBox('stsc', 0, 0, () => {
      b.u32(scRuns.length);
      let chunkIndex = 1;
      for (const run of scRuns) {
        b.u32(chunkIndex);
        b.u32(run.value);
        b.u32(1); // sample_description_index
        chunkIndex += run.count;
      }
    });

    // ---- stsz ----
    b.fullBox('stsz', 0, 0, () => {
      b.u32(0); // 变长
      b.u32(track.samples.length);
      for (const s of track.samples) b.u32(s.size);
    });

    // ---- stco ----
    b.fullBox('stco', 0, 0, () => {
      b.u32(track.chunks.length);
      for (const c of track.chunks) b.u32(cfg.baseOffset + c.offset);
    });
  }

  writeAvc1(b) {
    const { width, height, sps, pps } = this.videoConfig;
    b.box('avc1', () => {
      b.zeros(6);
      b.u16(1); // data_reference_index
      b.u16(0);
      b.u16(0);
      b.zeros(12);
      b.u16(width);
      b.u16(height);
      b.u32(0x00480000); // 72 dpi
      b.u32(0x00480000);
      b.u32(0);
      b.u16(1); // frame_count
      b.zeros(32); // compressorname
      b.u16(0x0018); // depth
      b.i16(-1);

      b.box('avcC', () => {
        b.u8(1);
        b.u8(sps[1]);
        b.u8(sps[2]);
        b.u8(sps[3]);
        b.u8(0xff); // lengthSizeMinusOne = 3
        b.u8(0xe1); // numOfSequenceParameterSets = 1
        b.u16(sps.length);
        b.bytes(sps);
        b.u8(1); // numOfPictureParameterSets
        b.u16(pps.length);
        b.bytes(pps);
      });
    });
  }

  writeMp4a(b) {
    const { sampleRate, channels, asc } = this.audioConfig;
    b.box('mp4a', () => {
      b.zeros(6);
      b.u16(1);
      b.zeros(8);
      b.u16(channels);
      b.u16(16); // samplesize
      b.u16(0);
      b.u16(0);
      b.u32(sampleRate * 0x10000);
      b.bytes(buildEsds(asc, sampleRate, channels));
    });
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function buildFtyp() {
  const b = new Bytes(64);
  b.box('ftyp', () => {
    b.ascii('isom');
    b.u32(512);
    b.ascii('isom');
    b.ascii('iso2');
    b.ascii('avc1');
    b.ascii('mp41');
  });
  return b.view();
}

/** 连续相同值压缩成 { count, value } 行程 */
function runLength(values) {
  const runs = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last.value === v) last.count += 1;
    else runs.push({ count: 1, value: v });
  }
  return runs;
}

function concatBytes(list) {
  if (list.length === 1) return list[0];
  let len = 0;
  for (const c of list) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of list) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** 内存 sink，测试用 */
export function memorySink() {
  const parts = [];
  let size = 0;
  return {
    parts,
    get size() {
      return size;
    },
    async write(bytes) {
      parts.push(bytes);
      size += bytes.length;
    },
    async close() {},
    toBytes() {
      return concatBytes(parts);
    }
  };
}

export { Bytes as ByteWriter, runLength };
