/**
 * 从 MP4 的前若干字节里认出「有哪些轨道」。
 *
 * 为什么需要：抖音 / 快手 / 部分课程站把音视频拆成两个文件下发（一个纯视频 mp4
 * + 一个纯音频 mp4），浏览器里看着是一个视频，嗅探出来却是两条。只有知道某条
 * 是「仅视频」还是「仅音频」，才能把它们配成一对再合并。
 *
 * 只解析头部的 `moov`（fMP4 的 init 段），所以几 KB 就够；`moov` 在文件尾部的
 * 老式 MP4 会返回 null，由调用方按「未知」处理，不影响下载。
 */

const VIDEO_CODEC = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'vp08', 'mp4v', 'dvh1', 'dvhe']);
const AUDIO_CODEC = new Set(['mp4a', 'ac-3', 'ec-3', 'opus', 'Opus', 'alac', 'fLaC', 'twos', 'sowt', 'ulaw', 'alaw']);

function fourcc(buf, at) {
  if (at + 4 > buf.length) return '';
  return String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
}

function readSize(buf, at) {
  if (at + 8 > buf.length) return 0;
  const size = ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
  const type = fourcc(buf, at + 4);
  if (size === 1) {
    if (at + 16 > buf.length) return 0;
    // 64 位长度：高位在我们关心的头部里几乎总是 0
    const hi = ((buf[at + 8] << 24) | (buf[at + 9] << 16) | (buf[at + 10] << 8) | buf[at + 11]) >>> 0;
    const lo = ((buf[at + 12] << 24) | (buf[at + 13] << 16) | (buf[at + 14] << 8) | buf[at + 15]) >>> 0;
    return { size: hi * 4294967296 + lo, header: 16, type };
  }
  return { size, header: 8, type };
}

/**
 * 在 [start, end) 范围内找指定类型的直接子 box。
 * @returns {{type:string, body:number, end:number}[]}
 */
function children(buf, start, end) {
  const list = [];
  let p = start;
  // 最多走 256 个 box，防止畸形数据把这里变成死循环
  for (let guard = 0; guard < 256; guard += 1) {
    const head = readSize(buf, p);
    if (!head || head.size < head.header) break;
    const boxEnd = Math.min(p + head.size, end);
    list.push({ type: head.type, body: p + head.header, end: boxEnd });
    if (boxEnd <= p) break;
    p = boxEnd;
    if (p >= end) break;
  }
  return list;
}

function findBox(buf, start, end, type) {
  return children(buf, start, end).find((b) => b.type === type) || null;
}

function trakInfo(buf, trak) {
  const mdia = findBox(buf, trak.body, trak.end, 'mdia');
  if (!mdia) return null;

  let handler = '';
  const hdlr = findBox(buf, mdia.body, mdia.end, 'hdlr');
  // hdlr: version/flags(4) + pre_defined(4) + handler_type(4)
  if (hdlr) handler = fourcc(buf, hdlr.body + 8);

  let codec = '';
  const minf = findBox(buf, mdia.body, mdia.end, 'minf');
  const stbl = minf ? findBox(buf, minf.body, minf.end, 'stbl') : null;
  const stsd = stbl ? findBox(buf, stbl.body, stbl.end, 'stsd') : null;
  // stsd: version/flags(4) + entry_count(4) + 第一条: size(4) + format(4)
  if (stsd) codec = fourcc(buf, stsd.body + 12);

  // stsz: version/flags(4) + sample_size(4) + sample_count(4)。
  // fMP4 的 init 段这里是 0 —— 样本全在 moof 里，是判断「分片流」的依据之一。
  const stsz = stbl ? findBox(buf, stbl.body, stbl.end, 'stsz') : null;
  const samples = stsz && stsz.body + 12 <= stsz.end ? readU32(buf, stsz.body + 8) : 0;

  const isVideo = handler === 'vide' || VIDEO_CODEC.has(codec);
  const isAudio = handler === 'soun' || AUDIO_CODEC.has(codec);
  if (!isVideo && !isAudio) return null;
  return { kind: isVideo ? 'video' : 'audio', codec, samples };
}

/**
 * @param {Uint8Array} buf 文件头部的字节（几 KB 到几十 KB 都行）
 * @returns {{video:boolean, audio:boolean, codecs:string[], fragmented:boolean, duration:number, emptyTracks:boolean} | null}
 *   拿不到 moov、或一条轨道都认不出时返回 null
 */
export function parseTrackKinds(buf) {
  if (!buf || buf.length < 16) return null;

  const top = children(buf, 0, buf.length);
  let moov = null;
  for (const box of top) {
    if (box.type === 'moov') {
      moov = box;
      break;
    }
  }
  if (!moov) return null;

  const codecs = [];
  let video = false;
  let audio = false;
  let emptyTracks = true;

  const inner = children(buf, moov.body, moov.end);
  for (const box of inner) {
    if (box.type !== 'trak') continue;
    const info = trakInfo(buf, box);
    if (!info) continue;
    if (info.kind === 'video') video = true;
    else audio = true;
    if (info.codec) codecs.push(info.codec);
    if (info.samples > 0) emptyTracks = false;
  }

  if (!video && !audio) return null;

  // fMP4（分片流）：moov 里只有编解码器配置，帧数据和样本表都在 moof 里。
  // 这种地址单独下下来只是整条流的一小段，绝不能当完整视频交付。
  const hasMoof = top.some((b) => b.type === 'moof');
  const mvex = findBox(buf, moov.body, moov.end, 'mvex');
  const fragmented = hasMoof || Boolean(mvex);

  let duration = 0;
  const mvhd = findBox(buf, moov.body, moov.end, 'mvhd');
  if (mvhd) {
    const v = buf[mvhd.body];
    const ts = v === 1 ? readU32(buf, mvhd.body + 20) : readU32(buf, mvhd.body + 12);
    const du = v === 1 ? readU64(buf, mvhd.body + 24) : readU32(buf, mvhd.body + 16);
    duration = ts ? du / ts : 0;
  }

  return { video, audio, codecs, fragmented, duration, emptyTracks };
}

function readU32(buf, at) {
  if (at + 4 > buf.length) return 0;
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

function readU64(buf, at) {
  return readU32(buf, at) * 4294967296 + readU32(buf, at + 4);
}

/** 人读标签，用于界面 */
export function trackLabel(tracks) {
  if (!tracks) return '';
  if (tracks.fragmented) return tracks.video ? '分片流·仅视频' : '分片流·仅音频';
  if (tracks.video && tracks.audio) return '音视频';
  if (tracks.video) return '仅视频（需配音频）';
  if (tracks.audio) return '仅音频';
  return '';
}
