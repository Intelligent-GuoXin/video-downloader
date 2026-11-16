/**
 * 测试用静态服务器。
 * - /hls/xxx.m3u8  : 真实播放列表文件，Content-Type: application/vnd.apple.mpegurl
 * - /hls/ 下的 .ts : 动态生成的分片字节（内容不重要，验证下载/拼接链路）
 * - /hls/keys/ 下的 .key : 16 字节 AES 密钥
 * - /media/ 下的文件 : 动态生成的伪媒体字节
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');

/** 与 /hls/720/index.m3u8 里的 IV=0x...01 对应，分片用 AES-128-CBC 真实加密 */
const AES_KEY = Buffer.from('0123456789abcdef', 'utf8');
const AES_IV = Buffer.concat([Buffer.alloc(15, 0), Buffer.from([1])]);

/** /media/ref-gated.mp4 的字节数，取一个不会和其他产物撞上的值，便于断言 */
export const REF_GATED_SIZE = 12345;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.key': 'application/octet-stream',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg'
};

/** 生成确定性伪字节，避免每次请求内容都变 */
function pseudoBytes(seed, size) {
  const buf = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (x >> 16) & 0xff;
  }
  return buf;
}

/** 把伪字节加密成合法的 AES-128-CBC 分片，用来验证解密链路 */
function encryptedSegment(seed, size) {
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
  return Buffer.concat([cipher.update(pseudoBytes(seed, size)), cipher.final()]);
}

function seedOf(str) {
  let h = 7;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
  return h;
}

// ---------------------------------------------------------------------------
// 合成 MP4 头：只为让 lib/mp4probe.js 有东西可解析
// ---------------------------------------------------------------------------

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}

/** version/flags + 载荷 */
function fullBox(type, payload) {
  return box(type, u32(0), payload);
}

/** 指定 version 与 flags 的 box */
function fullBoxEx(type, version, flags, payload) {
  return box(type, Buffer.from([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]), payload);
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

/** 一条 trak：mdia > (hdlr + minf > stbl > stsd > 样本条目) */
function trak(handler, codec) {
  const hdlr = fullBox('hdlr', Buffer.concat([u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(13)]));
  const entry = Buffer.concat([u32(16), Buffer.from(codec, 'latin1'), Buffer.alloc(4)]);
  const stsd = fullBox('stsd', Buffer.concat([u32(1), entry]));
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const mdia = box('mdia', hdlr, minf);
  return box('trak', mdia);
}

/**
 * 造一个「只有某些轨道」的 MP4 头。
 * moov 放在最前面（抖音就是这种排布），所以探 64KB 头就能认出来。
 * mvhd 里带真实时长 —— 配对按时长校验，没有时长的文件会拒绝自动配对。
 */
export function syntheticMp4(tracks = ['vide'], durationSec = 5) {
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2', 'latin1'));
  const traks = tracks.map((h) => trak(h, h === 'vide' ? 'avc1' : 'mp4a'));
  const mvhd = fullBoxEx('mvhd', 0, 0, Buffer.concat([
    u32(0), u32(0), u32(1000), u32(durationSec * 1000),
    u32(0x00010000), Buffer.from([0x01, 0x00]), Buffer.alloc(2), Buffer.alloc(8),
    Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]),
    Buffer.alloc(24), u32(2)
  ]));
  const moov = box('moov', mvhd, ...traks);
  const mdat = box('mdat', Buffer.alloc(4096, 7));
  return Buffer.concat([ftyp, moov, mdat]);
}

/**
 * 分片流（fMP4）：moov 里只有编解码器配置（没有 stsz），帧数据全在 moof/mdat。
 * 抖音的 .m4s 单独一条就是这种，原样存下来 `<video src>` 打不开，
 * 扩展要把它转成普通的 moov 前置 MP4。
 *
 * @param {number} frags 分片数 —— 用来制造「时长对不上」的音频候选
 *   （模拟信息流页面里别条视频的音轨混进同一页）。
 */
export function syntheticFmp4(handler = 'vide', frags = 6) {
  const isAudio = handler === 'soun';
  const MOVIE_TS = 1000;
  const TRACK_TS = 90000;
  const FRAGS = frags;
  const PER_FRAG = 5;
  const SAMPLE_DUR = 6000;
  const SAMPLE_SIZE = 800;
  const fragDur = PER_FRAG * SAMPLE_DUR;
  const totalDur = fragDur * FRAGS;

  const unity = Buffer.concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000)
  ]);

  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2', 'latin1'));

  const mvhd = fullBoxEx('mvhd', 0, 0, Buffer.concat([
    u32(0), u32(0), u32(MOVIE_TS), u32((totalDur * MOVIE_TS) / TRACK_TS),
    u32(0x00010000), Buffer.from([0x01, 0x00]), Buffer.alloc(2), Buffer.alloc(8),
    unity, Buffer.alloc(24), u32(2)
  ]));

  const tkhd = fullBoxEx('tkhd', 0, 3, Buffer.concat([
    u32(0), u32(0), u32(1), u32(0), u32((totalDur * MOVIE_TS) / TRACK_TS),
    Buffer.alloc(8), Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(2),
    unity, u32(1920 << 16), u32(1080 << 16)
  ]));

  const mdhd = fullBoxEx('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(TRACK_TS), u32(totalDur), u32(0x55c40000)]));
  const hdlr = fullBoxEx('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from(handler === 'soun' ? 'SoundHandler\0' : 'VideoHandler\0', 'latin1')]));
  const mediaHeader = handler === 'soun' ? fullBoxEx('smhd', 0, 0, Buffer.alloc(4)) : fullBoxEx('vmhd', 0, 1, Buffer.alloc(8));
  const dinf = box('dinf', fullBoxEx('dref', 0, 0, Buffer.concat([u32(1), fullBoxEx('url ', 0, 1, Buffer.alloc(0))])));

  const esds = fullBoxEx('esds', 0, 0, Buffer.alloc(24));
  const entry = isAudio
    ? box('mp4a', Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(8), u32(44100 << 16),
          Buffer.alloc(16), esds)
    : box('hvc1', Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(16),
          u32(1920), u32(1080), u32(0x00480000), u32(0x00480000), u32(0), Buffer.from([0, 1]),
          Buffer.alloc(32), Buffer.from([0, 0x18]), Buffer.from([0xff, 0xff]),
          box('hvcC', Buffer.concat([Buffer.from([1]), Buffer.alloc(100)])));
  const stbl = box('stbl', fullBoxEx('stsd', 0, 0, Buffer.concat([u32(1), entry])));
  const minf = box('minf', mediaHeader, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  const trex = fullBoxEx('trex', 0, 0, Buffer.concat([u32(1), u32(1), u32(0), u32(0), u32(0)]));
  const moov = box('moov', mvhd, trak, box('mvex', trex));

  const parts = [ftyp, moov];
  let dts = 0;
  for (let f = 0; f < FRAGS; f += 1) {
    const tfhd = fullBoxEx('tfhd', 0, 0x020000, u32(1)); // default-base-is-moof
    const tfdt = fullBoxEx('tfdt', 1, 0, u64(dts));
    const samples = [];
    for (let i = 0; i < PER_FRAG; i += 1) samples.push(u32(SAMPLE_DUR), u32(SAMPLE_SIZE));
    // trun: data_offset + sample_duration + sample_size
    const trun = (off) => fullBoxEx('trun', 0, 0x000301, Buffer.concat([u32(PER_FRAG), u32(off), ...samples]));
    const build = (off) => box('moof', fullBoxEx('mfhd', 0, 0, u32(f + 1)), box('traf', tfhd, tfdt, trun(off)));

    const dataOffset = build(0).length; // 数据紧跟在 moof 之后
    const payload = pseudoBytes(seedOf('frag' + f), SAMPLE_SIZE * PER_FRAG);
    parts.push(build(dataOffset), box('mdat', payload));
    dts += fragDur;
  }

  return Buffer.concat(parts);
}

/** 截断下载用：声明这么多，实际只给这么点 */
const TRUNCATED_DECLARED = 512 * 1024;
const TRUNCATED_ACTUAL = 32 * 1024;

const SYNTH = {
  '/media/vonly.mp4': syntheticMp4(['vide']),
  '/media/aonly.mp4': syntheticMp4(['soun']),
  '/media/frag.mp4': syntheticFmp4('vide'),
  '/dash/v.mp4': syntheticFmp4('vide'),
  '/dash/a.mp4': syntheticFmp4('soun'),
  // 时长 4 秒（v.mp4 是 2 秒）：模拟同页另一条视频的音轨混进候选。
  // 配对必须按时长拒绝它 —— 接上去就是「画面 2 秒、声音 4 秒」的错位文件。
  '/dash/a-short.mp4': syntheticFmp4('soun', 12)
};

export function startServer(port = 8899) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';

    const ext = path.extname(p).toLowerCase();

    // 动态生成：分片 / 密钥 / 伪媒体
    if (p.endsWith('.ts') && p.startsWith('/hls/')) {
      // /hls/720/ 下的分片是真加密的，/hls/360/ 与 /hls/audio/ 下的是明文
      const body = p.startsWith('/hls/720/')
        ? encryptedSegment(seedOf(p), 16384)
        : pseudoBytes(seedOf(p), 16384);
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
      res.end(body);
      return;
    }
    if (p.startsWith('/hls/keys/')) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': AES_KEY.length
      });
      res.end(AES_KEY);
      return;
    }
    if (p.startsWith('/media/') || p.startsWith('/dash/')) {
      // 合成头：一条只有视频轨、一条只有音频轨，用来验证轨道识别与配对
      if (SYNTH[p]) {
        const body = SYNTH[p];
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': body.length,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(body);
        return;
      }

      // 模拟抖音 CDN（douyinvod）：按 Referer 白名单判权，缺了 / 不对直接 403。
      // 浏览器自己发起的下载请求不会带页面 Referer，扩展必须靠 DNR 补上。
      if (p.includes('ref-gated') || p.includes('truncated')) {
        const ref = String(req.headers.referer || '');
        if (!ref.startsWith(`http://127.0.0.1:${port}/`)) {
          const deny = 'forbidden';
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(deny) });
          res.end(deny);
          return;
        }
      }

      // 连接中途断掉：头里声明 512KB，实际只给 32KB。
      // 早期实现只看「收到了字节」就当成成功，用户拿到的是打不开的残片。
      if (p.includes('truncated')) {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': TRUNCATED_DECLARED,
          'Cache-Control': 'no-store'
        });
        res.write(pseudoBytes(seedOf(p), TRUNCATED_ACTUAL));
        res.end();
        return;
      }
      const body = pseudoBytes(seedOf(p), p.includes('ref-gated') ? REF_GATED_SIZE : 8192);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': body.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(body);
      return;
    }

    // 静态文件
    const file = path.join(SITE, p);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
