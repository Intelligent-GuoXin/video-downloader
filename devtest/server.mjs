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
    if (p.startsWith('/media/')) {
      const body = pseudoBytes(seedOf(p), 8192);
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
