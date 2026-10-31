/**
 * MPEG-TS 解封装：把 HLS 的 .ts 分片解析成 H.264 访问单元 + AAC 帧。
 *
 * 为什么要自己写：浏览器内转 MP4 以前靠 ffmpeg.wasm，但它必须把输入和输出
 * 同时装进 wasm 线性内存，1GB 以上必 OOM，于是大文件只能降级成 TS。
 * 而 TS 里本来就是 H.264 + AAC，转 MP4 只是换容器、不需要重编码，
 * 只要自己解析包结构就能做到「内存与文件大小无关」。
 *
 * 设计约束：
 * - 零依赖，可在浏览器与 Node 里跑（测试用 Node）。
 * - 增量喂数据（push），跨分片的 PES 续传状态保留在实例里。
 * - 输出的样本是 AVCC 格式（4 字节长度前缀），可直接写进 MP4 的 mdat。
 */

const TS_PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;

const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_AAC = 0x0f;
const STREAM_TYPE_AAC_LATM = 0x11;
const STREAM_TYPE_HEVC = 0x24;

const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

/** TS 时钟 90kHz */
export const VIDEO_TIMESCALE = 90000;

// ---------------------------------------------------------------------------
// 位读取（SPS 解析用）
// ---------------------------------------------------------------------------

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0; // 以 bit 计
  }

  bit() {
    const byte = this.bytes[this.pos >> 3];
    const bit = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos += 1;
    return bit;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | this.bit();
    return v;
  }

  /** 无符号指数哥伦布 */
  ue() {
    let zeros = 0;
    while (this.pos < this.bytes.length * 8 && this.bit() === 0) zeros += 1;
    if (this.pos >= this.bytes.length * 8) return 0;
    return (1 << zeros) - 1 + (zeros ? this.bits(zeros) : 0);
  }

  /** 有符号指数哥伦布 */
  se() {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -(v / 2);
  }
}

/** 去掉 H.264 的防竞争字节：00 00 03 → 00 00 */
function unescapeNal(src) {
  const out = new Uint8Array(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i += 1) {
    if (i >= 2 && i + 1 < src.length && src[i] === 0x03 && src[i - 1] === 0 && src[i - 2] === 0) {
      continue;
    }
    out[n++] = src[i];
  }
  return out.subarray(0, n);
}

/** 从 SPS 推导显示宽高（含裁剪），失败返回 null */
export function parseSpsSize(sps) {
  try {
    const rle = unescapeNal(sps.subarray(1)); // 去掉 nal header
    const r = new BitReader(rle);
    const profileIdc = r.bits(8);
    r.bits(8); // constraint flags
    r.bits(8); // level
    r.ue(); // sps id

    let chromaFormatIdc = 1;
    let separateColourPlane = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) separateColourPlane = r.bit();
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.bit(); // qpprime_y_zero_transform_bypass_flag
      if (r.bit()) {
        // seq_scaling_matrix_present_flag：逐列表跳过，格式复杂但不影响宽高，
        // 这里只能按 4:2:0 的 8 个列表走；解析异常由外层 catch 兜住。
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i += 1) {
          if (!r.bit()) continue;
          const size = i < 6 ? 16 : 64;
          let lastScale = 8;
          let nextScale = 8;
          for (let j = 0; j < size; j += 1) {
            if (nextScale !== 0) {
              const delta = r.se();
              nextScale = (lastScale + delta + 256) % 256;
            }
            lastScale = nextScale === 0 ? lastScale : nextScale;
          }
        }
      }
    }

    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue();
    } else if (pocType === 1) {
      r.bit();
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i += 1) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.bit(); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field_flag
    r.bit(); // direct_8x8_inference_flag

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (r.bit()) {
      cropLeft = r.ue();
      cropRight = r.ue();
      cropTop = r.ue();
      cropBottom = r.ue();
    }

    const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
    const subWidthC = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
    const subHeightC = chromaArrayType === 1 ? 2 : 1;
    const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
    const cropUnitY = chromaArrayType === 0 ? 2 - frameMbsOnly : subHeightC * (2 - frameMbsOnly);

    const width = widthMbs * 16 - (cropLeft + cropRight) * cropUnitX;
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropTop + cropBottom) * cropUnitY;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height, profileIdc };
  } catch {
    return null;
  }
}

/** ADTS 头解析：7 字节（无 CRC）或 9 字节（有 CRC） */
function parseAdts(bytes, offset) {
  if (offset + 7 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf0) !== 0xf0) return null;
  const protectionAbsent = bytes[offset + 1] & 1;
  const profile = (bytes[offset + 2] >> 6) & 3; // 0=Main 1=LC 2=SSR
  const freqIndex = (bytes[offset + 2] >> 2) & 0x0f;
  const channelConfig = ((bytes[offset + 2] & 1) << 2) | ((bytes[offset + 3] >> 6) & 3);
  const frameLength =
    ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | ((bytes[offset + 5] >> 5) & 7);
  const headerLength = protectionAbsent ? 7 : 9;
  if (frameLength < headerLength + 1) return null;
  return { profile, freqIndex, channelConfig, frameLength, headerLength };
}

const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
];

/** AudioSpecificConfig：5 bits AOT + 4 bits freqIndex + 4 bits channelConfig */
function buildAsc(profile, freqIndex, channelConfig) {
  const aot = profile + 1; // ADTS profile 0/1 → AOT 1/2
  const b0 = (aot << 3) | ((freqIndex >> 1) & 7);
  const b1 = ((freqIndex & 1) << 7) | (channelConfig << 3);
  return new Uint8Array([b0, b1]);
}

/**
 * 解析 PES 头里的 PTS/DTS（33 bit @90kHz）。
 *
 * 5 个字节的排布是「3 组 7 位 + 标记位」：
 *   b0: 4bit 前缀 | PTS[32:30] | marker
 *   b1: PTS[29:22]
 *   b2: PTS[21:14]
 *   b3: PTS[13:7]  | marker
 *   b4: PTS[6:0]   | marker
 * 标记位必须屏蔽掉，否则时间戳会整体错位（表现为帧间隔变成半帧）。
 */
function readTimestamp(b, o) {
  const hi = (b[o] >> 1) & 0x07;
  const mid = (b[o + 1] << 22) | (b[o + 2] << 14) | ((b[o + 3] & 0xfe) << 6) | (b[o + 4] >> 1);
  return hi * 4294967296 + (mid >>> 0);
}

// ---------------------------------------------------------------------------
// 解封装器
// ---------------------------------------------------------------------------

export class TsDemuxer {
  /**
   * @param {object} opts
   * @param {(sample: object) => void} opts.onSample 每解出一个样本回调一次
   */
  constructor(opts = {}) {
    this.onSample = opts.onSample || null;

    this.pmtPid = -1;
    this.videoPid = -1;
    this.audioPid = -1;
    this.pcrPid = -1;
    this.unsupported = '';

    /** 当前正在组装的 PES：{ pid, dts, pts, hasTs, chunks: Uint8Array[] } */
    this.pending = { video: null, audio: null };
    /** 上一个分片残留的半个 TS 包 */
    this.leftover = null;

    this.sps = null;
    this.pps = null;
    this.size = null;
    this.audioConfig = null;

    this.stats = {
      videoSamples: 0,
      audioSamples: 0,
      bytes: 0,
      /** 关键帧数量，用于校验 stss */
      keyframes: 0,
      firstVideoDts: null,
      lastVideoDts: 0,
      firstAudioDts: null,
      lastAudioDts: 0
    };
  }

  // -------------------------------------------------------------------------
  // 包层
  // -------------------------------------------------------------------------

  push(bytes) {
    if (!bytes || !bytes.length) return;
    this.stats.bytes += bytes.length;

    let data = bytes;
    if (this.leftover && this.leftover.length) {
      const merged = new Uint8Array(this.leftover.length + data.length);
      merged.set(this.leftover, 0);
      merged.set(data, this.leftover.length);
      data = merged;
      this.leftover = null;
    }

    // 找同步字节（有些流开头有 ID3 之类的前缀）
    let start = 0;
    while (start + TS_PACKET_SIZE <= data.length && data[start] !== SYNC_BYTE) start += 1;
    if (start > 0 && start + TS_PACKET_SIZE > data.length) {
      this.leftover = data.slice(-(TS_PACKET_SIZE - 1));
      return;
    }

    let p = start;
    for (; p + TS_PACKET_SIZE <= data.length; p += TS_PACKET_SIZE) {
      if (data[p] !== SYNC_BYTE) {
        // 失步：跳到下一个同步点
        let q = p + 1;
        while (q < data.length && data[q] !== SYNC_BYTE) q += 1;
        p = q - TS_PACKET_SIZE;
        continue;
      }
      this.packet(data, p);
    }
    if (p < data.length) this.leftover = data.slice(p);
  }

  packet(buf, off) {
    const b1 = buf[off + 1];
    const pusi = (b1 >> 6) & 1;
    const pid = ((b1 & 0x1f) << 8) | buf[off + 2];
    const afc = (buf[off + 3] >> 4) & 3;

    // afc: 0=保留 1=仅负载 2=仅自适应 3=自适应+负载
    if (afc === 0 || afc === 2) return;

    let payloadStart = off + 4;
    if (afc === 3) {
      const afLen = buf[off + 4];
      payloadStart += 1 + afLen;
    }
    if (payloadStart >= off + TS_PACKET_SIZE) return;

    if (pid === 0) {
      this.parsePat(buf, payloadStart, pusi);
      return;
    }
    if (pid === this.pmtPid) {
      this.parsePmt(buf, payloadStart, pusi);
      return;
    }
    if (pid === this.videoPid) {
      this.parsePes(buf, payloadStart, off, pusi, 'video');
    } else if (pid === this.audioPid) {
      this.parsePes(buf, payloadStart, off, pusi, 'audio');
    }
  }

  /** PSI section 的负载起点（PUSI 时有 pointer_field） */
  sectionStart(buf, p, pusi) {
    if (!pusi) return p;
    return p + 1 + buf[p];
  }

  parsePat(buf, p, pusi) {
    const s = this.sectionStart(buf, p, pusi);
    if (buf[s] !== 0x00) return; // table_id != PAT
    const sectionLength = ((buf[s + 1] & 0x0f) << 8) | buf[s + 2];
    const end = Math.min(s + 3 + sectionLength - 4, buf.length);
    // 跳过 transport_stream_id(2) + version(1) + section_number(1) + last(1)
    let q = s + 8;
    while (q + 4 <= end) {
      const programNumber = (buf[q] << 8) | buf[q + 1];
      const pid = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3];
      if (programNumber !== 0) {
        this.pmtPid = pid;
        return;
      }
      q += 4;
    }
  }

  parsePmt(buf, p, pusi) {
    const s = this.sectionStart(buf, p, pusi);
    if (buf[s] !== 0x02) return;
    const sectionLength = ((buf[s + 1] & 0x0f) << 8) | buf[s + 2];
    const end = Math.min(s + 3 + sectionLength - 4, buf.length);

    this.pcrPid = ((buf[s + 8] & 0x1f) << 8) | buf[s + 9];
    const programInfoLength = ((buf[s + 10] & 0x0f) << 8) | buf[s + 11];
    let q = s + 12 + programInfoLength;

    while (q + 5 <= end) {
      const streamType = buf[q];
      const pid = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2];
      const esInfoLength = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4];
      q += 5 + esInfoLength;

      if (streamType === STREAM_TYPE_H264) {
        if (this.videoPid === -1) this.videoPid = pid;
      } else if (streamType === STREAM_TYPE_AAC || streamType === STREAM_TYPE_AAC_LATM) {
        if (this.audioPid === -1) {
          this.audioPid = pid;
          this.audioIsLatm = streamType === STREAM_TYPE_AAC_LATM;
        }
      } else if (streamType === STREAM_TYPE_HEVC) {
        this.unsupported = 'HEVC/H.265';
      }
    }
  }

  parsePes(buf, p, packetStart, pusi, track) {
    const pktEnd = packetStart + TS_PACKET_SIZE;
    if (pusi) {
      // 新 PES 开始：把上一帧交付
      this.flush(track);

      const headerEnd = p + 9;
      if (headerEnd > pktEnd) return;
      if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) {
        // 不是合法 PES 头，跳过这一包
        return;
      }
      const flags = buf[p + 7];
      const ptsDtsFlags = (flags >> 6) & 3;
      const headerDataLength = buf[p + 8];
      const dataStart = p + 9 + headerDataLength;

      let pts = -1;
      let dts = -1;
      if (ptsDtsFlags === 2 || ptsDtsFlags === 3) {
        pts = readTimestamp(buf, p + 9);
        dts = ptsDtsFlags === 3 ? readTimestamp(buf, p + 14) : pts;
      }

      this.pending[track] = {
        chunks: dataStart < pktEnd ? [buf.subarray(dataStart, pktEnd)] : [],
        pts,
        dts
      };
    } else {
      const cur = this.pending[track];
      if (!cur) return; // 没有 PES 头就来的续包，丢弃
      cur.chunks.push(buf.subarray(p, pktEnd));
    }
  }

  // -------------------------------------------------------------------------
  // 样本层
  // -------------------------------------------------------------------------

  flush(track) {
    const pes = this.pending[track];
    if (!pes || !pes.chunks.length) {
      this.pending[track] = null;
      return;
    }
    this.pending[track] = null;

    const payload = concat(pes.chunks);
    if (track === 'video') this.emitVideo(payload, pes.dts, pes.pts);
    else this.emitAudio(payload, pes.dts, pes.pts);
  }

  /** 把 Annex-B 的 NAL 序列转成 AVCC（4 字节长度前缀） */
  emitVideo(annexb, dts, pts) {
    const nals = splitAnnexB(annexb);
    if (!nals.length) return;

    let key = false;
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === NAL_IDR) key = true;
      if (type === NAL_SPS && !this.sps) {
        this.sps = nal.slice();
        this.size = this.size || parseSpsSize(nal);
        if (this.size) this.profileIdc = this.size.profileIdc;
      } else if (type === NAL_PPS && !this.pps) {
        this.pps = nal.slice();
      }
    }

    // SPS/PPS 已经在 avcC 里，样本中剔除，避免解码器重复初始化
    let total = 0;
    let count = 0;
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === NAL_SPS || type === NAL_PPS) continue;
      total += 4 + nal.length;
      count += 1;
    }
    if (!count) return; // 纯参数集，不构成帧

    const out = new Uint8Array(total);
    let o = 0;
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === NAL_SPS || type === NAL_PPS) continue;
      out[o] = (nal.length >>> 24) & 0xff;
      out[o + 1] = (nal.length >>> 16) & 0xff;
      out[o + 2] = (nal.length >>> 8) & 0xff;
      out[o + 3] = nal.length & 0xff;
      out.set(nal, o + 4);
      o += 4 + nal.length;
    }

    const s = this.stats;
    if (s.firstVideoDts === null) s.firstVideoDts = dts;
    s.lastVideoDts = dts;
    s.videoSamples += 1;
    if (key) s.keyframes += 1;

    if (this.onSample) {
      this.onSample({
        track: 'video',
        data: out,
        dts,
        cts: pts >= 0 ? pts : dts,
        key,
        size: out.length
      });
    }
  }

  emitAudio(payload, dts, pts) {
    // 一个 PES 里通常有多个 ADTS 帧，逐帧切出来
    let o = 0;
    let first = true;
    while (o + 7 <= payload.length) {
      const info = parseAdts(payload, o);
      if (!info) {
        // 失步：尝试跳到下一个 0xFFF 同步点
        let q = o + 1;
        while (q + 7 <= payload.length && !(payload[q] === 0xff && (payload[q + 1] & 0xf0) === 0xf0)) {
          q += 1;
        }
        if (q + 7 > payload.length) break;
        o = q;
        continue;
      }

      if (!this.audioConfig) {
        this.audioConfig = {
          profile: info.profile,
          freqIndex: info.freqIndex,
          sampleRate: AAC_RATES[info.freqIndex] || 48000,
          channels: info.channelConfig || 2,
          asc: buildAsc(info.profile, info.freqIndex, info.channelConfig || 2)
        };
      }

      const frame = payload.subarray(o + info.headerLength, o + info.frameLength);
      if (frame.length) {
        const s = this.stats;
        // 音频时间戳按帧序推算：AAC 恒定 1024 采样/帧。
        // 用 PES 的 PTS 打基准，避免逐帧比较 90kHz 精度带来的抖动。
        const sampleRate = this.audioConfig.sampleRate;
        const stamp = first && pts >= 0 ? Math.round((pts / VIDEO_TIMESCALE) * sampleRate) : -1;
        if (s.firstAudioDts === null && stamp >= 0) s.firstAudioDts = stamp;

        if (s.firstAudioDts === null) s.firstAudioDts = 0;
        const at = s.audioSamples * 1024;
        s.lastAudioDts = at;
        s.audioSamples += 1;

        if (this.onSample) {
          this.onSample({
            track: 'audio',
            data: frame,
            dts: at,
            cts: at,
            key: true,
            size: frame.length
          });
        }
      }

      o += info.frameLength;
      first = false;
    }
  }

  /** 收尾：交付最后一个未完成的 PES */
  end() {
    this.flush('video');
    this.flush('audio');
    // 丢掉不足一个包的尾巴
    this.leftover = null;
    return this.stats;
  }
}

function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** 按起始码切分 Annex-B 为 NAL 列表（不含起始码） */
function splitAnnexB(bytes) {
  const nals = [];
  const len = bytes.length;
  let i = 0;
  let start = -1;

  const isStartCode = (p) =>
    p + 3 <= len && bytes[p] === 0 && bytes[p + 1] === 0 && bytes[p + 2] === 1;
  const isStartCode4 = (p) =>
    p + 4 <= len && bytes[p] === 0 && bytes[p + 1] === 0 && bytes[p + 2] === 0 && bytes[p + 3] === 1;

  while (i < len) {
    if (isStartCode4(i)) {
      if (start >= 0) nals.push(bytes.subarray(start, i));
      i += 4;
      start = i;
    } else if (isStartCode(i)) {
      if (start >= 0) nals.push(bytes.subarray(start, i));
      i += 3;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start >= 0 && start < len) nals.push(bytes.subarray(start, len));

  // 过滤空 NAL
  return nals.filter((n) => n.length > 0);
}

export { splitAnnexB, unescapeNal };
