/**
 * ISOLATED world 桥接脚本。
 * 职责：① 扫描 DOM 里的 <video>/<source>/链接；② 接收 MAIN world 插桩上报的消息；
 *       ③ 判断「哪个视频正在播放」并上报；④ 去重后转发给 Service Worker。
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

  // ---------------------------------------------------------------------------
  // 「正在播放」上报
  //
  // 信息流页面（抖音搜索页 / 推荐流）会预加载一串别的视频，它们同样产生媒体请求，
  // 按「最近请求」排序永远分不清谁在播。真正可靠的证据是：
  // - blob: 播放器：MAIN world 的 appendBuffer 插桩报告「某个 URL 被喂进了某个
  //   MediaSource」，这里再核对挂着该 blob 地址的 <video> 元素确实在播（未暂停）；
  // - 直连 <video src>：元素本身未暂停、进度在走，currentSrc 就是答案。
  // 命中后把 URL + 元数据报给后台，列表据此把正在播放的那条顶到最前面。
  // ---------------------------------------------------------------------------

  let lastPlaying = { url: '', at: 0 };

  const isElementActive = (v) => {
    try {
      return !v.paused || v.currentTime > 0;
    } catch {
      return false;
    }
  };

  const reportPlaying = (url, el) => {
    if (!alive() || !url) return;
    const abs = absolute(url);
    if (!/^https?:/i.test(abs)) return;
    const now = Date.now();
    if (lastPlaying.url === abs && now - lastPlaying.at < 5000) return;
    lastPlaying = { url: abs, at: now };

    const meta = {
      duration: el && Number.isFinite(el.duration) ? el.duration : 0,
      width: (el && el.videoWidth) || 0,
      height: (el && el.videoHeight) || 0,
      poster: (el && el.poster) || ''
    };
    try {
      chrome.runtime.sendMessage({ type: 'PLAYING', url: abs, meta }, () => void chrome.runtime.lastError);
    } catch {
      /* 忽略 */
    }
  };

  const handleFeed = (d) => {
    try {
      const el = [...document.querySelectorAll('video')].find((v) => v.currentSrc === d.blobUrl);
      if (el && isElementActive(el)) reportPlaying(d.url, el);
    } catch {
      /* 忽略 */
    }
  };

  const scanPlaying = () => {
    try {
      for (const v of document.querySelectorAll('video')) {
        const src = v.currentSrc || v.src || '';
        if (/^https?:/i.test(src) && isElementActive(v)) {
          reportPlaying(src, v);
        }
      }
    } catch {
      /* 忽略 */
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
    scanPlaying();
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
      } else if (d.kind === 'feed') {
        handleFeed(d);
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
