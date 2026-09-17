/**
 * 极简 m3u8 解析器（零依赖，可在 SW / Offscreen 中运行）。
 * 覆盖：master / media playlist、EXT-X-MEDIA 音轨、AES-128 加密、EXT-X-MAP、EXT-X-BYTERANGE。
 */

export function resolveUrl(u, base) {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

/** 解析 KEY=VALUE,KEY=VALUE 形式的属性列表，值可带引号 */
function attrList(line) {
  const out = {};
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m = re.exec(line);
  while (m) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
    m = re.exec(line);
  }
  return out;
}

function parseByteRange(value) {
  if (!value) return null;
  const [len, off] = String(value).split('@');
  const length = Number(len);
  if (!Number.isFinite(length) || length <= 0) return null;
  const offset = Number(off);
  return { length, offset: Number.isFinite(offset) ? offset : null };
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const audioGroups = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrList(line.slice('#EXT-X-MEDIA:'.length));
      if ((a.TYPE || '').toUpperCase() === 'AUDIO' && a.URI) {
        const gid = a['GROUP-ID'] || '';
        if (!audioGroups[gid]) audioGroups[gid] = [];
        audioGroups[gid].push({
          name: a.NAME || '',
          lang: a.LANGUAGE || '',
          url: resolveUrl(a.URI, baseUrl),
          isDefault: a.DEFAULT === 'YES'
        });
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrList(line.slice('#EXT-X-STREAM-INF:'.length));
      const next = lines[i + 1];
      if (!next || next.startsWith('#')) continue;
      const [w, h] = String(a.RESOLUTION || '').split('x');
      variants.push({
        url: resolveUrl(next, baseUrl),
        bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0) || 0,
        width: Number(w) || 0,
        height: Number(h) || 0,
        codecs: a.CODECS || '',
        audioGroup: a.AUDIO || '',
        name: a.NAME || ''
      });
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  for (const v of variants) {
    const list = audioGroups[v.audioGroup];
    if (list && list.length) {
      const pick = list.find((x) => x.isDefault) || list[0];
      v.audioUrl = pick.url;
      v.audioName = pick.name || pick.lang || '';
    }
  }

  return { type: 'master', variants };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let key = null;
  let map = null;
  let targetDuration = 0;
  let totalDuration = 0;
  let endList = false;
  let seq = 0;
  let pendingDuration = 0;
  let pendingRange = null;
  let isFmp4 = false;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrList(line.slice('#EXT-X-KEY:'.length));
      const method = (a.METHOD || 'NONE').toUpperCase();
      key = method === 'NONE' ? null : {
        method,
        url: a.URI ? resolveUrl(a.URI, baseUrl) : '',
        iv: a.IV || ''
      };
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrList(line.slice('#EXT-X-MAP:'.length));
      map = a.URI ? { url: resolveUrl(a.URI, baseUrl), byteRange: a.BYTERANGE || '' } : null;
      isFmp4 = true;
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
      continue;
    }
    if (line.startsWith('#')) continue;

    segments.push({
      url: resolveUrl(line, baseUrl),
      duration: pendingDuration,
      seq: seq + segments.length,
      byteRange: pendingRange,
      key
    });
    totalDuration += pendingDuration;
    pendingDuration = 0;
    pendingRange = null;
  }

  // 上游可能用了未带加密信息的 KEY 行（METHOD=NONE），此时 key 为 null 是正确的
  const encrypted = segments.some((s) => s.key && s.key.method !== 'NONE');

  return {
    type: 'media',
    segments,
    map,
    targetDuration,
    totalDuration,
    endList,
    isFmp4,
    encrypted,
    keyMethod: encrypted ? segments.find((s) => s.key).key.method : ''
  };
}

/**
 * @param {string} text 播放列表原文
 * @param {string} baseUrl 播放列表自身 URL（用于解析相对路径）
 * @returns {{type:'master',variants:Array}|{type:'media',segments:Array,map:object|null,totalDuration:number,endList:boolean,encrypted:boolean,isFmp4:boolean}}
 */
export function parsePlaylist(text, baseUrl) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    return parseMaster(lines, baseUrl);
  }
  return parseMedia(lines, baseUrl);
}

export function isMasterText(text) {
  return /#EXT-X-STREAM-INF/.test(String(text || ''));
}

/** 序列号 → 16 字节大端 IV（HLS 未显式给 IV 时的默认规则） */
export function ivFromSequence(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq || 0);
  for (let i = 15; i >= 0 && n > 0n; i -= 1) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

export function ivFromHex(hex) {
  const h = String(hex || '').replace(/^0x/i, '');
  const out = new Uint8Array(16);
  const padded = h.padStart(32, '0').slice(-32);
  for (let i = 0; i < 16; i += 1) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}
