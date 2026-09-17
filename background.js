/**
 * Service Worker：检测归并 + 下载编排。
 *
 * 设计要点（MV3 约束下的必要取舍）：
 * - SW 会被随时回收，所有检测结果写 chrome.storage.session，不放在内存变量里。
 * - 下载/合流这类长任务一律交给 offscreen document（SW 无 DOM、30s 空闲即死）。
 * - webRequest 在 MV3 只能「观测」不能「改写」，所以这里的角色是嗅探，不是拦截。
 */

import {
  MEDIA_HINT,
  classify,
  isNoise,
  isHttp,
  guessExt,
  pathKey,
  shortHash,
  hostOf,
  sanitizeName
} from './lib/media.js';
import { parsePlaylist } from './lib/m3u8.js';
import * as store from './lib/store.js';

const OFFSCREEN_URL = 'offscreen.html';
const REFERER_RULE_ID = 9001;
const VISIBLE_KINDS = new Set(['hls', 'dash', 'direct', 'audio']);

let offscreenCreating = null;

// ---------------------------------------------------------------------------
// Offscreen document 管理
// ---------------------------------------------------------------------------

async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS', 'WORKERS'],
        justification: '在本地下载 HLS 分片、解密并转封装为 MP4'
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  return offscreenCreating;
}

function toOffscreen(payload) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload }).catch(() => null);
}

function toPopup(payload) {
  return chrome.runtime.sendMessage({ target: 'popup', ...payload }).catch(() => null);
}

// ---------------------------------------------------------------------------
// 检测：webRequest 观测
// ---------------------------------------------------------------------------

const WEBREQ_FILTER = {
  urls: ['http://*/*', 'https://*/*'],
  types: ['media', 'xmlhttprequest', 'object', 'other', 'main_frame', 'sub_frame']
};

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const hit = headers.find((h) => h.name && h.name.toLowerCase() === name);
  return hit ? hit.value || '' : '';
}

function shouldConsider(url, mime) {
  if (!isHttp(url) || isNoise(url)) return false;
  if (MEDIA_HINT.test(url)) return true;
  const m = String(mime || '').toLowerCase();
  return m.startsWith('video/') || m.startsWith('audio/') || m.includes('mpegurl') || m.includes('dash+xml');
}

function onCandidate(tabId, url, mime, extra) {
  if (tabId == null || tabId < 0) return;
  if (!shouldConsider(url, mime)) return;
  const kind = classify(url, mime);
  if (kind === 'segment' || kind === 'unknown') return;

  // 异步落盘，不阻塞 webRequest 回调
  void ingest({ tabId, url, kind, mime, ...extra });
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  onCandidate(d.tabId, d.url, '', { initiator: d.initiator || '' });
}, WEBREQ_FILTER);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const headers = d.responseHeaders || [];
    onCandidate(d.tabId, d.url, headerValue(headers, 'content-type'), {
      initiator: d.initiator || '',
      size: Number(headerValue(headers, 'content-length')) || 0,
      acceptRanges: headerValue(headers, 'accept-ranges')
    });
  },
  WEBREQ_FILTER,
  ['responseHeaders']
);

// ---------------------------------------------------------------------------
// 归并入库
// ---------------------------------------------------------------------------

/**
 * 同一个 tab 的状态是「读-改-写」，而 webRequest / 内容脚本 / 探测会并发触发，
 * 不加锁就会互相覆盖（实测表现为：偶尔丢失 HLS 清晰度列表）。
 * 这里用一条 Promise 链把所有写入串行化；SW 单线程，全局一把锁足够。
 */
let writeChain = Promise.resolve();

function withTabLock(tabId, mutator) {
  const run = writeChain.then(async () => {
    const state = (await store.getTab(tabId)) || store.emptyTab(tabId, '', '');
    const result = await mutator(state);
    await store.setTab(state);
    return result;
  });
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const probeTimers = new Map();

async function ingest({ tabId, url, kind, mime = '', size = 0, initiator = '', source = 'net', meta = {} }) {
  if (!isHttp(url)) return;

  const id = await withTabLock(tabId, (state) => {
    const itemId = shortHash(pathKey(url) + '|' + kind);
    const existing = state.items[itemId];

    const item = existing
      ? { ...existing, mime: mime || existing.mime, size: size || existing.size }
      : {
          id: itemId,
          url,
          kind,
          mime,
          size,
          source,
          initiator,
          pageUrl: state.url || '',
          ts: Date.now(),
          title: '',
          poster: '',
          width: 0,
          height: 0,
          duration: 0,
          variants: [],
          probed: false,
          drm: false
        };

    // DOM 扫描带来的元数据更丰富，优先保留
    for (const k of ['title', 'poster', 'width', 'height', 'duration']) {
      if (meta[k]) item[k] = meta[k];
    }

    state.items[itemId] = item;
    if (kind === 'hls' && !item.probed) scheduleProbe(tabId, itemId, url);
    return itemId;
  });

  await refreshBadge(tabId);
  return id;
}

/** 拉一次播放列表，拿到清晰度列表 / 分片数，让 popup 有好东西展示 */
function scheduleProbe(tabId, itemId, url) {
  const key = `${tabId}:${itemId}`;
  const old = probeTimers.get(key);
  if (old) clearTimeout(old);
  probeTimers.set(
    key,
    setTimeout(() => {
      probeTimers.delete(key);
      void probe(tabId, itemId, url);
    }, 700)
  );
}

async function probe(tabId, itemId, url) {
  let playlist;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return;
    playlist = parsePlaylist(await res.text(), url);
  } catch {
    return; // 探测失败不影响主流程：真正下载时会再拉一次
  }

  await withTabLock(tabId, (state) => {
    const item = state.items[itemId];
    if (!item) return;
    item.probed = true;

    if (playlist.type === 'master') {
      item.isMaster = true;
      item.variants = playlist.variants.map((v) => ({
        url: v.url,
        bandwidth: v.bandwidth,
        width: v.width,
        height: v.height,
        audioUrl: v.audioUrl || '',
        label: v.height ? `${v.height}p` : `${Math.round(v.bandwidth / 1000)}kbps`
      }));
    } else {
      item.isMaster = false;
      item.variants = [];
      item.segmentCount = playlist.segments.length;
      item.duration = playlist.totalDuration || item.duration || 0;
      item.encrypted = Boolean(playlist.encrypted);
      item.keyMethod = playlist.keyMethod || '';
      item.isFmp4 = Boolean(playlist.isFmp4);
      item.isLive = !playlist.endList;
    }
  });

  await refreshBadge(tabId);
}

// ---------------------------------------------------------------------------
// 徽标
// ---------------------------------------------------------------------------

async function refreshBadge(tabId) {
  try {
    const state = await store.getTab(tabId);
    const n = state ? Object.values(state.items).filter((i) => VISIBLE_KINDS.has(i.kind)).length : 0;
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#185FA5' });
  } catch {
    /* tab 已关闭 */
  }
}

// ---------------------------------------------------------------------------
// 下载：直链
// ---------------------------------------------------------------------------

function buildFilename(state, item, ext) {
  const host = hostOf(state.url || item.pageUrl || item.url) || 'video';
  const base = sanitizeName(item.title || state.title || host, 'video');
  const uniq = item.id.slice(0, 5);
  return `视频嗅探/${sanitizeName(host, 'site')}/${base}-${uniq}.${ext}`;
}

async function startDirectDownload(tabId, itemId) {
  const state = await store.getTab(tabId);
  const item = state && state.items && state.items[itemId];
  if (!item) throw new Error('条目已失效，请重新嗅探');

  const ext = guessExt(item.kind, item.mime, item.url);
  const filename = buildFilename(state, item, ext);

  const downloadId = await chrome.downloads.download({
    url: item.url,
    filename,
    saveAs: false
  });
  return { downloadId, filename };
}

// ---------------------------------------------------------------------------
// 下载：HLS 分片流（交给 offscreen）
// ---------------------------------------------------------------------------

async function startHlsJob({ tabId, itemId, variantUrl, audioUrl, output }) {
  const state = await store.getTab(tabId);
  const item = state && state.items && state.items[itemId];
  if (!item) throw new Error('条目已失效，请重新嗅探');

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id: jobId,
    tabId,
    itemId,
    type: 'hls',
    url: item.url,
    variantUrl: variantUrl || '',
    audioUrl: audioUrl || '',
    output: output === 'ts' ? 'ts' : 'mp4',
    pageUrl: state.url || '',
    title: item.title || state.title || '',
    host: hostOf(state.url || item.url),
    stage: '准备中',
    progress: 0,
    received: 0,
    total: 0,
    filename: '',
    error: '',
    downloadId: null,
    ts: Date.now()
  };

  await store.setJob(job);
  await ensureOffscreen();

  // 部分 CDN 会校验 Referer，缺了直接 403。只在任务期间挂规则，结束就摘掉。
  if (job.pageUrl) await applyRefererRule(job.pageUrl);

  await toOffscreen({ type: 'JOB_START', job });
  await toPopup({ type: 'JOB_UPDATE', job });
  return job;
}

async function applyRefererRule(referer) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REFERER_RULE_ID],
      addRules: [
        {
          id: REFERER_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'referer', operation: 'set', value: referer }]
          },
          condition: { urlFilter: '*', resourceTypes: ['xmlhttprequest'] }
        }
      ]
    });
  } catch {
    /* 规则失败不该拖垮下载 */
  }
}

async function clearRefererRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [REFERER_RULE_ID] });
  } catch {
    /* 忽略 */
  }
}

async function cancelJob(jobId) {
  await toOffscreen({ type: 'JOB_CANCEL', jobId });
  await store.patchJob(jobId, { stage: '已取消', cancelled: true });
  await clearRefererRule();
}

// ---------------------------------------------------------------------------
// 下载结果落地
// ---------------------------------------------------------------------------

const trackedDownloads = new Map(); // downloadId -> { jobId, blobUrl }

chrome.downloads.onChanged.addListener(async (delta) => {
  const tracked = trackedDownloads.get(delta.id);
  if (!tracked) return;
  if (!delta.state || (delta.state.current !== 'complete' && delta.state.current !== 'interrupted')) return;

  trackedDownloads.delete(delta.id);
  await clearRefererRule();

  await store.patchJob(tracked.jobId, {
    stage: delta.state.current === 'complete' ? '已完成' : '下载被中断',
    progress: delta.state.current === 'complete' ? 100 : undefined
  });
  const job = await store.getJob(tracked.jobId);
  await toPopup({ type: 'JOB_UPDATE', job });

  // 让 offscreen 释放这个 blob，否则内存会一直占着
  await toOffscreen({ type: 'RELEASE_BLOB', blobUrl: tracked.blobUrl });
});

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;
  if (msg.target === 'offscreen' || msg.target === 'popup') return undefined;

  const tabIdFromSender = sender.tab ? sender.tab.id : null;

  switch (msg.type) {
    case 'DETECT':
      void handleDetect(msg, tabIdFromSender);
      return undefined;

    case 'PAGE_META':
      void handlePageMeta(msg.meta, tabIdFromSender);
      return undefined;

    case 'GET_STATE':
      (async () => {
        const tabId = msg.tabId;
        const state = await store.getTab(tabId);
        const job = await store.getActiveJob(tabId);
        let tabInfo = null;
        try {
          tabInfo = await chrome.tabs.get(tabId);
        } catch {
          /* 忽略 */
        }
        sendResponse({
          ok: true,
          tab: state
            ? { ...state, items: Object.values(state.items).sort((a, b) => b.ts - a.ts) }
            : null,
          job,
          page: tabInfo ? { url: tabInfo.url, title: tabInfo.title } : null
        });
      })();
      return true;

    case 'CLEAR_TAB':
      (async () => {
        await store.clearTab(msg.tabId);
        await refreshBadge(msg.tabId);
        sendResponse({ ok: true });
      })();
      return true;

    case 'REMOVE_ITEM':
      (async () => {
        const state = await store.getTab(msg.tabId);
        if (state && state.items[msg.itemId]) {
          delete state.items[msg.itemId];
          await store.setTab(state);
          await refreshBadge(msg.tabId);
        }
        sendResponse({ ok: true });
      })();
      return true;

    case 'DOWNLOAD_DIRECT':
      (async () => {
        try {
          const r = await startDirectDownload(msg.tabId, msg.itemId);
          sendResponse({ ok: true, ...r });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      })();
      return true;

    case 'START_HLS_JOB':
      (async () => {
        try {
          const job = await startHlsJob(msg);
          sendResponse({ ok: true, job });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      })();
      return true;

    case 'CANCEL_JOB':
      (async () => {
        await cancelJob(msg.jobId);
        sendResponse({ ok: true });
      })();
      return true;

    // 诊断用：确认 ffmpeg.wasm 引擎在扩展环境里可用。
    // 故意做成「立刻回执 + 异步落盘」：整套自检要现场编码再转封装，耗时可能超过
    // Service Worker 的存活时间，同步等结果会拿到 "message port closed"。
    // 结果由 offscreen 通过 SELFTEST_RESULT 回传（回传消息会把休眠的 SW 唤醒）。
    case 'ENGINE_SELFTEST':
      (async () => {
        await store.setDiag('engine', { running: true, startedAt: Date.now() });
        try {
          await ensureOffscreen();
          void toOffscreen({ type: 'ENGINE_SELFTEST' });
          sendResponse({ ok: true, started: true });
        } catch (e) {
          const error = String(e && e.message ? e.message : e);
          await store.setDiag('engine', { running: false, error });
          sendResponse({ ok: false, error });
        }
      })();
      return true;

    case 'JOB_STAGE':
    case 'JOB_PROGRESS':
    case 'JOB_READY':
    case 'JOB_ERROR':
    case 'SELFTEST_RESULT':
      void handleOffscreenReport(msg);
      return undefined;

    default:
      return undefined;
  }
});

async function handleDetect(msg, tabId) {
  if (tabId == null) return;
  const frame = msg.frame || {};

  if (frame.drm || frame.mse) {
    await withTabLock(tabId, (state) => {
      if (frame.drm) {
        state.drm = true;
        if (frame.drmKeySystem) state.drmKeySystem = frame.drmKeySystem;
      }
      if (frame.mse) state.mse = true;
    });
  }

  for (const it of msg.items || []) {
    if (!isHttp(it.url)) continue;
    const kind = classify(it.url, it.mime);
    if (kind === 'segment' || kind === 'unknown') continue;
    await ingest({
      tabId,
      url: it.url,
      kind,
      mime: it.mime || '',
      size: it.size || 0,
      source: it.source || 'dom',
      meta: {
        title: it.text || it.title || '',
        poster: it.poster || '',
        width: it.width || 0,
        height: it.height || 0,
        duration: it.duration || 0
      }
    });
  }
}

async function handlePageMeta(meta, tabId) {
  if (tabId == null || !meta) return;
  await withTabLock(tabId, (state) => {
    // 只有顶层 frame 的标题/地址才是页面本身，iframe 内的不要覆盖
    if (meta.top) {
      state.url = meta.url || state.url;
      state.title = meta.title || state.title;
    } else if (!state.url) {
      state.url = meta.url || '';
    }
  });
}

async function handleOffscreenReport(msg) {
  if (msg.type === 'SELFTEST_RESULT') {
    await store.setDiag('engine', { running: false, result: msg.result });
    return;
  }

  const jobId = msg.jobId;
  if (!jobId) return;
  const job = await store.getJob(jobId);
  if (!job) return;

  if (msg.type === 'JOB_STAGE') {
    await store.patchJob(jobId, { stage: msg.stage || job.stage });
  } else if (msg.type === 'JOB_PROGRESS') {
    await store.patchJob(jobId, {
      stage: msg.stage || job.stage,
      progress: Number(msg.progress) || 0,
      received: msg.received || 0,
      total: msg.total || 0
    });
  } else if (msg.type === 'JOB_ERROR') {
    await store.patchJob(jobId, { stage: '失败', error: msg.message || '未知错误' });
    await clearRefererRule();
  } else if (msg.type === 'JOB_READY') {
    try {
      const downloadId = await chrome.downloads.download({
        url: msg.blobUrl,
        filename: msg.filename,
        saveAs: false
      });
      trackedDownloads.set(downloadId, { jobId, blobUrl: msg.blobUrl });
      await store.patchJob(jobId, {
        stage: '写入磁盘',
        progress: 100,
        filename: msg.filename,
        downloadId
      });
    } catch (e) {
      await store.patchJob(jobId, {
        stage: '失败',
        error: `保存失败：${String(e && e.message ? e.message : e)}`
      });
      await toOffscreen({ type: 'RELEASE_BLOB', blobUrl: msg.blobUrl });
      await clearRefererRule();
    }
  }

  const updated = await store.getJob(jobId);
  await toPopup({ type: 'JOB_UPDATE', job: updated });
}

// ---------------------------------------------------------------------------
// 标签页生命周期
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  void store.clearTab(tabId);
  void store.clearActiveJob(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // 导航到新页面：旧页面的检测结果作废
    void (async () => {
      await store.clearTab(tabId);
      await store.clearActiveJob(tabId);
      await refreshBadge(tabId);
    })();
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void refreshBadge(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  void store.pruneTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void store.pruneTabs();
});
