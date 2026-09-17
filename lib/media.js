/**
 * 媒体类型识别与通用小工具。
 * 被 Service Worker / Offscreen / Popup 以 ESM 方式引用，禁止依赖 DOM。
 */

const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv', 'ogv', 'mpg', 'mpeg', '3gp', 'm2ts'
]);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus']);
const SEGMENT_EXT = new Set(['ts', 'm4s']);

/** 快速预筛：只有命中这个正则的 URL 才值得做后续（较贵的）异步处理 */
export const MEDIA_HINT =
  /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|avi|mpeg|mpg|3gp|m2ts|mp3|m4a|aac|flac|wav|ogg|opus|ts|m4s)(\?|#|$)/i;

const EXT_RE = /\.([a-z0-9]{2,5})(?=$|[?#])/i;

export function isHttp(url) {
  return /^https?:/i.test(String(url || ''));
}

export function extOf(rawUrl) {
  try {
    const p = new URL(rawUrl, 'https://placeholder.invalid/').pathname;
    const m = p.match(EXT_RE);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * 把一条网络请求归类。
 * @returns {'hls'|'dash'|'segment'|'direct'|'audio'|'unknown'}
 */
export function classify(rawUrl, mime) {
  const url = String(rawUrl || '');
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  const ext = extOf(url);

  if (ext === 'm3u8' || m.includes('mpegurl')) return 'hls';
  if (ext === 'mpd' || m.includes('dash+xml')) return 'dash';
  if (SEGMENT_EXT.has(ext) || m.includes('mp2t') || m.includes('iso.segment')) return 'segment';
  if (m.startsWith('video/')) return 'direct';
  if (m.startsWith('audio/')) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'direct';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'unknown';
}

/** 明显不是媒体资源的噪音请求 */
export function isNoise(url) {
  const u = String(url || '');
  if (!isHttp(u)) return true;
  if (u.startsWith('https://placeholder.invalid')) return false;
  return (
    /\.(js|mjs|css|json|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|xml|txt)(\?|#|$)/i.test(u) ||
    /\/(beacon|analytics|collect|track|telemetry|log)\b/i.test(u)
  );
}

const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/mp2t': 'ts',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac'
};

export function extFromMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  return MIME_EXT[m] || '';
}

export function guessExt(kind, mime, url) {
  return extFromMime(mime) || extOf(url) || (kind === 'audio' ? 'mp3' : 'mp4');
}

export function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function humanDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeName(name, fallback = 'video') {
  let s = String(name || '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = fallback;
  return s.length > 120 ? s.slice(0, 120) : s;
}

/** 去掉 query（含签名 token），用于去重同一个资源 */
export function pathKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url || '');
  }
}

/** 稳定短 hash，用作条目 id */
export function shortHash(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
