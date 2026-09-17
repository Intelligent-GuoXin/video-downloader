/**
 * ISOLATED world 桥接脚本。
 * 职责：① 扫描 DOM 里的 <video>/<source>/链接；② 接收 MAIN world 插桩上报的消息；
 *       ③ 去重后转发给 Service Worker。
 */
(() => {
  'use strict';

  const seen = new Set();
  const pending = [];
  let flushTimer = null;
  let scanTimer = null;
  let mseDetected = false;
  let drmDetected = false;
  let drmKeySystem = '';
  let reported = false;

  const alive = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  const post = (item) => {
    const key = item.url;
    if (!key || seen.has(key)) return;
    seen.add(key);
    pending.push(item);
    if (!flushTimer) flushTimer = setTimeout(flush, 400);
  };

  const flush = () => {
    flushTimer = null;
    if (!pending.length || !alive()) return;
    const items = pending.splice(0, pending.length);
    const frameMeta = { mse: mseDetected, drm: drmDetected, drmKeySystem };
    try {
      chrome.runtime.sendMessage({ type: 'DETECT', items, frame: frameMeta }, () => {
        // 读一下 lastError，避免 "Unchecked runtime.lastError" 噪音
        void chrome.runtime.lastError;
      });
    } catch {
      /* 扩展被重载，忽略 */
    }
  };

  const reportPageMeta = () => {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'PAGE_META',
          meta: {
            url: location.href,
            title: document.title || '',
            top: window === window.top
          }
        },
        () => void chrome.runtime.lastError
      );
    } catch {
      /* 忽略 */
    }
  };

  const absolute = (u) => {
    if (!u) return '';
    try {
      return new URL(u, location.href).toString();
    } catch {
      return '';
    }
  };

  const addVideo = (url, extra) => {
    const abs = absolute(url);
    if (!abs || !/^https?:/i.test(abs)) {
      if (abs.startsWith('blob:')) {
        mseDetected = true;
        flushSoon();
      }
      return;
    }
    post({ url: abs, source: 'dom', ...extra });
  };

  const flushSoon = () => {
    if (!flushTimer) flushTimer = setTimeout(flush, 400);
  };

  // ---------- DOM 扫描 ----------
  const scan = () => {
    try {
      for (const v of document.querySelectorAll('video, audio')) {
        const meta = {
          poster: v.poster || '',
          duration: Number.isFinite(v.duration) ? v.duration : 0,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
          mime: ''
        };
        if (v.currentSrc) addVideo(v.currentSrc, meta);
        if (v.src) addVideo(v.src, meta);
        for (const s of v.querySelectorAll('source')) {
          addVideo(s.src, { ...meta, mime: s.type || '' });
        }
      }

      // 直链视频的超链接也顺手收进来（不少下载页就是这么放的）
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (/\.(mp4|m4v|webm|mkv|mov|flv|m3u8)(\?|#|$)/i.test(href)) {
          addVideo(href, { source: 'link', text: (a.textContent || '').trim().slice(0, 120) });
        }
      }
    } catch {
      /* 忽略 */
    }
  };

  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
      reportPageMeta();
    }, 300);
  };

  // ---------- MAIN world 上报 ----------
  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.__vdsniffer !== true) return;

      if (d.kind === 'url') {
        const abs = absolute(d.url);
        if (abs) post({ url: abs, source: d.via === 'xhr' ? 'xhr' : 'fetch' });
      } else if (d.kind === 'drm') {
        drmDetected = true;
        drmKeySystem = d.keySystem || '';
        flushSoon();
      } else if (d.kind === 'mse') {
        mseDetected = true;
        flushSoon();
      } else if (d.kind === 'blob') {
        mseDetected = true;
        flushSoon();
      } else if (d.kind === 'frame') {
        reportPageMeta();
      }
    },
    false
  );

  // ---------- 生命周期 ----------
  const start = () => {
    if (reported) return;
    reported = true;
    scan();
    reportPageMeta();

    try {
      const mo = new MutationObserver(scheduleScan);
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch {
      /* 忽略 */
    }

    // 兜底轮询：应对 MutationObserver 覆盖不到的场景（如 canvas 播放器换源）
    setInterval(scan, 2500);
    document.addEventListener('visibilitychange', scheduleScan);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // ---------- 响应 popup 的「重新嗅探」 ----------
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'FORCE_SCAN') {
        start();
        scan();
        reportPageMeta();
        sendResponse({ ok: true });
      }
      return undefined;
    });
  } catch {
    /* 忽略 */
  }
})();
