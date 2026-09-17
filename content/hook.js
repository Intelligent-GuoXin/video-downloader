/**
 * MAIN world 插桩脚本。
 *
 * 为什么必须跑在 MAIN world：blob: 播放器（MSE）的真实分片地址只存在于页面自己的
 * JS 上下文里，扩展的 ISOLATED world 看不到。只有在页面上下文里包一层 fetch / XHR /
 * MediaSource 才能把真实请求暴露出来。
 *
 * 用 content_scripts 的 world:"MAIN" 注入可以绕开页面 CSP（用 <script> 标签注入会被拦）。
 * 本文件必须保持「零副作用」：任何插桩失败都静默跳过，绝不能影响页面自身逻辑。
 */
(() => {
  'use strict';

  const FLAG = '__vdsniffer_hooked__';
  if (Object.prototype.hasOwnProperty.call(window, FLAG)) return;
  try {
    Object.defineProperty(window, FLAG, { value: true, enumerable: false });
  } catch {
    return;
  }

  const MEDIA_RE =
    /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|m2ts|ts|m4s|mp3|m4a|aac|flac|ogg|opus|wav)(\?|#|$)/i;

  const send = (payload) => {
    try {
      window.postMessage({ __vdsniffer: true, ...payload }, '*');
    } catch {
      /* 忽略 */
    }
  };

  /**
   * 页面里拿到的往往是相对路径（如 "/media/a.mp4"），必须在这里补成绝对地址，
   * 否则桥接层/后台的 http(s) 校验会直接把它丢掉。
   */
  const absolute = (u) => {
    try {
      return new URL(String(u), location.href).toString();
    } catch {
      return '';
    }
  };

  // ---------- 1. DRM / EME 探测 ----------
  // 页面调用 requestMediaKeySystemAccess 就说明在用 CDM 解密，这类内容我们做不了，
  // 必须早点告诉用户，而不是让他下到一堆没法播的加密分片。
  try {
    const orig = navigator.requestMediaKeySystemAccess;
    if (typeof orig === 'function') {
      navigator.requestMediaKeySystemAccess = function (keySystem) {
        send({ kind: 'drm', keySystem: String(keySystem || '') });
        return orig.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  // ---------- 2. MSE 探测 ----------
  // 页面往 SourceBuffer 里塞数据 → 说明是分片流播放器，DOM 里的 blob: 地址没有意义。
  try {
    const MS = window.MediaSource;
    if (MS && MS.prototype && typeof MS.prototype.addSourceBuffer === 'function') {
      const origAdd = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (mime) {
        send({ kind: 'mse', mime: String(mime || '') });
        return origAdd.apply(this, arguments);
      };
    }
    const origCreate = URL.createObjectURL;
    if (typeof origCreate === 'function') {
      URL.createObjectURL = function (obj) {
        const url = origCreate.apply(this, arguments);
        try {
          if (MS && obj instanceof MS) send({ kind: 'blob', url });
        } catch {
          /* 忽略 */
        }
        return url;
      };
    }
  } catch {
    /* 忽略 */
  }

  // ---------- 3. fetch 插桩 ----------
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          const raw = typeof input === 'string' ? input : input && input.url;
          if (raw && MEDIA_RE.test(raw)) {
            const url = absolute(raw);
            if (url) send({ kind: 'url', url, via: 'fetch' });
          }
        } catch {
          /* 忽略 */
        }
        return origFetch.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  // ---------- 4. XHR 插桩 ----------
  try {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (proto && typeof proto.open === 'function') {
      const origOpen = proto.open;
      proto.open = function (method, url) {
        try {
          if (url && MEDIA_RE.test(url)) {
            const abs = absolute(url);
            if (abs) send({ kind: 'url', url: abs, via: 'xhr' });
          }
        } catch {
          /* 忽略 */
        }
        return origOpen.apply(this, arguments);
      };
    }
  } catch {
    /* 忽略 */
  }

  // ---------- 5. 上报当前帧地址，便于把资源归属到正确的 frame ----------
  try {
    send({ kind: 'frame', url: location.href });
  } catch {
    /* 忽略 */
  }
})();
