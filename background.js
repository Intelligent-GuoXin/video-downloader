/**
 * Service Worker：检测归并 + 下载编排。
 *
 * 设计要点（MV3 约束下的必要取舍）：
 * - SW 会被随时回收，所有检测结果写 chrome.storage.session，不放在内存变量里。
 * - 下载/合流这类长任务一律交给 offscreen document（见 lib/offscreendoc.js）。
 * - webRequest 在 MV3 只能「观测」不能「改写」，所以这里的角色是嗅探，不是拦截。
 * - 「正在播放的是哪条流」由内容脚本判定（喂流关系 + 播放器元素状态），
 *   SW 只负责把标记落到条目上 —— 信息流页面预加载的干扰靠这个排除。
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
  resumeKeyOf
} from './lib/media.js';
import { parsePlaylist } from './lib/m3u8.js';
import * as store from './lib/store.js';
import { applyRefererRule, clearRefererRule } from './lib/referer.js';
import { ensureOffscreen, toOffscreen, toPopup } from './lib/offscreendoc.js';
import { buildFilename } from './lib/naming.js';

const VISIBLE_KINDS = new Set(['hls', 'dash', 'direct', 'audio']);
/** 「正在播放」标记的有效期：超时未续报就摘掉，避免换视频后旧标记残留 */
const PLAYING_TTL = 15000;

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
      ? {
          ...existing,
          mime: mime || existing.mime,
          size: size || existing.size,
          // 记下「最后一次被请求」的时间。抖音搜索页会预加载一串其它视频，
          // 靠首次捕获顺序排列表就是随机的；真正在播的那条会持续请求分片，
          // lastSeen 一直更新，才能把它顶到最前面。
          lastSeen: Date.now()
        }
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
          lastSeen: Date.now(),
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
// 「正在播放」标记
// ---------------------------------------------------------------------------

/**
 * 内容脚本确认了正在播放的流地址（喂流关系 + 播放器元素状态）。
 *
 * 标记是带 TTL 的集合而不是单值：DASH 场景下视频流、音频流交替被喂，
 * 两条都属于正在播放的那个视频；预加载视频的流没人喂，自然进不来。
 * 播放器元素的时长也一并记下 —— DASH 流探不出 moov，这是它唯一的时长来源，
 * 也是后面「按时长配对音轨」的前提。
 */
async function markPlaying(tabId, url, meta = {}) {
  if (tabId == null || !isHttp(url)) return;
  const pk = pathKey(url);
  const now = Date.now();

  await withTabLock(tabId, (state) => {
    state.playing = state.playing || {};
    state.playing[pk] = now;
    // 顺手清掉超时条目，防止长驻页面把 map 撑大
    for (const k of Object.keys(state.playing)) {
      if (now - state.playing[k] > PLAYING_TTL) delete state.playing[k];
    }

    for (const it of Object.values(state.items)) {
      if (pathKey(it.url) === pk) {
        it.playing = true;
        it.lastSeen = Math.max(it.lastSeen || it.ts || 0, now);
        // 播放器元素知道的时长比「没有」强；已有值不覆盖（可能是分片表算出来的）
        if (meta.duration && !it.duration) it.duration = meta.duration;
        if (meta.width && !it.width) it.width = meta.width;
        if (meta.height && !it.height) it.height = meta.height;
        if (meta.poster && !it.poster) it.poster = meta.poster;
      } else if (it.playing) {
        // 该地址不在喂流集合里，且集合已超时 → 摘掉旧标记
        const seenAt = state.playing[pathKey(it.url)];
        if (!seenAt || now - seenAt > PLAYING_TTL) it.playing = false;
      }
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

function directFilename(state, item, ext) {
  const pageUrl = state.url || item.pageUrl || '';
  return buildFilename({
    pageUrl,
    url: item.url,
    title: item.title || state.title || '',
    uniq: item.id.slice(0, 5),
    ext
  });
}

async function startDirectDownload(tabId, itemId, audioItemId) {
  const state = await store.getTab(tabId);
  const item = state && state.items && state.items[itemId];
  if (!item) throw new Error('条目已失效，请重新嗅探');

  const audioItem = audioItemId && state.items ? state.items[audioItemId] : null;
  const audioUrl = audioItem ? audioItem.url : '';

  const ext = guessExt(item.kind, item.mime, item.url);
  const filename = directFilename(state, item, ext);
  const pageUrl = state.url || item.pageUrl || '';

  const ctxInfo = {
    tabId,
    itemId,
    url: item.url,
    audioUrl,
    ext,
    filename,
    pageUrl,
    host: hostOf(pageUrl || item.url),
    title: item.title || '',
    audioCandidates: audioUrl ? [] : pickAudioCandidates(state, itemId)
  };

  // 要合并音轨就没法交给浏览器下载器 —— 必须自己拿到两段字节
  if (audioUrl) {
    const job = await startDirectFetchJob(ctxInfo);
    return { viaFetch: true, merged: true, job };
  }

  // 先探 64KB，看这个地址放不放行，顺便认出它有几条轨道。
  // 403/401 意味着 CDN 按 Referer（或登录态）判权，而 chrome.downloads 发出的
  // 请求既没有页面 Referer、也不吃扩展的 DNR 规则 —— 只能改成抓下来另存。
  const probe = await probeUrl(item.url);
  if (probe.tracks) await rememberTracks(tabId, itemId, probe);

  // 分片流必须走抓取路径：浏览器下载器只会把字节原样存下来，
  // 得到一个 `<video src>` 打不开的 fMP4；offscreen 里才会转成普通 MP4。
  if (probe.tracks && probe.tracks.fragmented) {
    const job = await startDirectFetchJob(ctxInfo);
    return { viaFetch: true, converted: true, job };
  }

  // 抖音 DASH 的视频/音频流在分片 URL 上探不出轨道（开头没有 moov）。
  // 这种条目必须抓回来解析：是「仅视频」就自动在同页候选里找音轨合并，
  // 交给浏览器下载器的话用户只会拿到一个没声音的文件。
  if (!probe.tracks && item.kind === 'direct') {
    const job = await startDirectFetchJob(ctxInfo);
    return { viaFetch: true, job };
  }

  // 「仅视频」的普通直链也走抓取：页面里可能有配不上的音轨，下载时再试
  if (probe.tracks && probe.tracks.video && !probe.tracks.audio && ctxInfo.audioCandidates.length) {
    const job = await startDirectFetchJob(ctxInfo);
    return { viaFetch: true, job };
  }

  if (probe.status === 401 || probe.status === 403) {
    const job = await startDirectFetchJob(ctxInfo);
    return { viaFetch: true, job };
  }

  // 常规路径：交给浏览器下载器（可续传、不占扩展内存）
  const downloadId = await chrome.downloads.download({
    url: item.url,
    filename,
    saveAs: false
  });
  trackedDownloads.set(downloadId, {
    ruleKey: '',
    // 下载被拒时兜底用：这些信息够重新抓一次
    retry: ctxInfo
  });
  return { downloadId, filename };
}

/**
 * 给「下载时自动配对」挑候选音轨。
 *
 * 依据：抖音 DASH 的视频流和音频流几乎同时请求（播放器同步缓冲两条），
 * 所以「同页、最近 90 秒内请求过、不是明确仅视频」的直链条目最可疑。
 * 只带 3 条：下载候选是真实流量，宁可少试不可乱试。
 *
 * 注意这里只是「候选」：真正的配对在 offscreen 里按时长硬校验
 * （见 jobs/direct.js 的 tryAudioCandidates），对不上的一律不合并。
 */
function pickAudioCandidates(state, selfId) {
  if (!state || !state.items) return [];
  const cutoff = Date.now() - 90000;
  return Object.values(state.items)
    .filter((it) => {
      if (it.id === selfId) return false;
      if (it.kind !== 'direct' && it.kind !== 'audio') return false;
      // 明确标了「仅视频」的不可能是音轨
      if (it.tracks && it.tracks.video && !it.tracks.audio) return false;
      return true;
    })
    .sort((a, b) => (b.playing ? 1 : 0) - (a.playing ? 1 : 0) || (b.lastSeen || b.ts || 0) - (a.lastSeen || a.ts || 0))
    .filter((it) => (it.lastSeen || it.ts || 0) > cutoff)
    .slice(0, 3)
    .map((it) => it.url);
}

/** 探活：拿不到结果就当作「未知」，走常规路径，不阻断下载 */
async function probeUrl(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensureOffscreen();
    } catch {
      return { status: 0, ok: false, tracks: null };
    }
    const r = await toOffscreen({ type: 'PROBE_URL', url });
    if (r && typeof r.status === 'number') return r;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { status: 0, ok: false, tracks: null };
}

/**
 * 记下探测到的轨道构成。
 *
 * 抖音把音视频拆成两个文件下发，界面上必须能看出哪条「仅视频」、哪条「仅音频」，
 * 否则用户就是现在这样：下完发现画面没声音。
 */
async function rememberTracks(tabId, itemId, probe) {
  await withTabLock(tabId, (state) => {
    const item = state.items[itemId];
    if (!item) return;
    item.trackProbed = true;
    if (!probe || !probe.tracks) return;
    item.tracks = probe.tracks;
    if (probe.mime && !item.mime) item.mime = probe.mime;
    if (probe.total && !item.size) item.size = probe.total;
    if (probe.tracks.duration && !item.duration) item.duration = probe.tracks.duration;
    if (probe.tracks.audio && !probe.tracks.video) item.kind = 'audio';
  });
}

/** 给列表里的直链条目补上「仅视频 / 仅音频 / 音视频」标记 */
async function classifyItems(tabId) {
  let probed = 0;
  // 分批探完所有条目。早期只探一批 8 条就返回，列表一长后面的条目
  // 永远拿不到轨道标记 —— 用户看到的「仅视频」条目没有配对按钮，
  // 或者音频条目标不出「仅音频」，等于这个功能对长列表失效。
  // 每条只是一个 64KB 的 Range 请求，20 条也就 1.3MB。
  for (let round = 0; round < 8; round += 1) {
    const state = await store.getTab(tabId);
    if (!state) break;
    const pending = Object.values(state.items).filter(
      (it) => !it.trackProbed && (it.kind === 'direct' || it.kind === 'audio')
    );
    if (!pending.length) break;

    const batch = pending.slice(0, 8);
    await Promise.all(
      batch.map(async (it) => {
        const probe = await probeUrl(it.url);
        await rememberTracks(tabId, it.id, probe);
      })
    );
    probed += batch.length;
    if (batch.length < 8) break;
  }
  return probed;
}

/**
 * 受限直链：offscreen 里带 Referer 抓取 → 落 OPFS → blob 交下载器。
 * 与 HLS 复用同一套 job 通道，所以 popup 的进度条、取消、失败提示都一样能用。
 */
async function startDirectFetchJob({ tabId, itemId, url, audioUrl, ext, filename, pageUrl, host, title, audioCandidates }) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id: jobId,
    tabId,
    itemId,
    type: 'direct',
    url,
    audioUrl: audioUrl || '',
    audioCandidates: audioCandidates || [],
    ext,
    filename,
    pageUrl,
    host,
    title,
    stage: '准备中',
    progress: 0,
    received: 0,
    total: 0,
    error: '',
    downloadId: null,
    ts: Date.now()
  };

  await store.setJob(job);
  await ensureOffscreen();
  if (pageUrl) {
    await applyRefererRule(jobId, url, pageUrl);
    // 音轨可能在另一个域名上，单独给它挂一条
    if (audioUrl) await applyRefererRule(jobId + ':a', audioUrl, pageUrl);
  }

  try {
    await startJobOnOffscreen(job);
  } catch (e) {
    const reason = String(e && e.message ? e.message : e);
    await clearRefererRule(jobId);
    await store.patchJob(jobId, { stage: '失败', error: reason });
    throw new Error(reason);
  }

  await toPopup({ type: 'JOB_UPDATE', job });
  return job;
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
    // 断点续传身份：同一个视频（token 变了也算同一个）永远算出同样的值，
    // offscreen 用它决定分片目录，从而能接着上次的进度下。
    downloadKey: resumeKeyOf(variantUrl || item.url),
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
  if (job.pageUrl) await applyRefererRule(job.id, job.variantUrl || job.url, job.pageUrl);

  // 必须看回执：offscreen 可能因为并发上限 / 引擎异常拒绝这个任务，
  // 早期版本把回执吞掉，界面就会永远停在「准备中 0%」。
  try {
    await startJobOnOffscreen(job);
  } catch (e) {
    const reason = String(e && e.message ? e.message : e);
    await clearRefererRule(job.id);
    await store.patchJob(job.id, { stage: '失败', error: reason });
    throw new Error(reason);
  }

  await toPopup({ type: 'JOB_UPDATE', job });
  return job;
}

/**
 * 把任务交给 offscreen，并确认它真的接下了。
 * offscreen 刚被创建时监听器可能还没挂上，第一次投递会拿不到回执，因此重试一次；
 * 重试若撞上「已在运行」，说明第一次其实已经生效，按成功处理。
 */
async function startJobOnOffscreen(job) {
  let ack = await toOffscreen({ type: 'JOB_START', job });
  if (!ack) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    ack = await toOffscreen({ type: 'JOB_START', job });
  }
  if (ack && ack.ok) return;
  if (ack && ack.error === '该任务已在运行') return;
  throw new Error((ack && ack.error) || '无法与下载引擎通信（offscreen 未就绪）');
}

async function cancelJob(jobId) {
  await toOffscreen({ type: 'JOB_CANCEL', jobId });
  await store.patchJob(jobId, { stage: '已取消', cancelled: true });
  await clearRefererRule(jobId);
}

// ---------------------------------------------------------------------------
// 下载结果落地
// ---------------------------------------------------------------------------

/**
 * downloadId -> { ruleKey, jobId?, blobUrl? }
 * 直链下载没有 job 记录（进度交给 Chrome 下载栏），只带 ruleKey 用来摘 Referer 规则。
 */
const trackedDownloads = new Map();

chrome.downloads.onChanged.addListener(async (delta) => {
  const tracked = trackedDownloads.get(delta.id);
  if (!tracked) return;
  if (!delta.state || (delta.state.current !== 'complete' && delta.state.current !== 'interrupted')) return;

  trackedDownloads.delete(delta.id);
  if (tracked.ruleKey) await clearRefererRule(tracked.ruleKey);

  // 直链下载到此为止：没有 job 需要回写
  if (!tracked.jobId) {
    if (delta.state.current !== 'interrupted') return;

    const reason = String(delta.error || '');
    // 浏览器下载请求带不上页面 Referer（DNR 对下载请求不生效）。
    // 探测阶段侥幸放行、真正下载却被拒时，改用 offscreen 抓取再试一次。
    if (tracked.retry && (reason.includes('FORBIDDEN') || reason.includes('UNAUTHORIZED'))) {
      try {
        await startDirectFetchJob(tracked.retry);
      } catch (e) {
        console.warn('[vd] 兜底抓取失败：', String(e && e.message ? e.message : e));
      }
      return;
    }
    console.warn('[vd] 直链下载被中断', reason);
    return;
  }

  await store.patchJob(tracked.jobId, {
    stage: delta.state.current === 'complete' ? '已完成' : '下载被中断',
    progress: delta.state.current === 'complete' ? 100 : undefined
  });
  const job = await store.getJob(tracked.jobId);
  await toPopup({ type: 'JOB_UPDATE', job });

  // 文件已经落到用户磁盘了，分片目录可以清掉；
  // 中断的情况要保留 —— 那正是下次续传的凭据。
  if (delta.state.current === 'complete' && job && job.downloadKey) {
    await toOffscreen({ type: 'PURGE_JOB', downloadKey: job.downloadKey });
  }

  // 让 offscreen 释放这个 blob，否则内存会一直占着
  if (tracked.blobUrl) await toOffscreen({ type: 'RELEASE_BLOB', blobUrl: tracked.blobUrl });
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

    // 内容脚本确认的「正在播放」地址（喂流关系 + 播放器元素状态）
    case 'PLAYING':
      void markPlaying(tabIdFromSender, msg.url, msg.meta || {});
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
        await withTabLock(msg.tabId, (state) => {
          delete state.items[msg.itemId];
        });
        await refreshBadge(msg.tabId);
        sendResponse({ ok: true });
      })();
      return true;

    case 'DOWNLOAD_DIRECT':
      (async () => {
        try {
          const r = await startDirectDownload(msg.tabId, msg.itemId, msg.audioItemId);
          sendResponse({ ok: true, ...r });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      })();
      return true;

    // 给直链条目补「仅视频 / 仅音频 / 音视频」标记（顺手探测，失败不影响下载）
    case 'CLASSIFY_ITEMS':
      (async () => {
        try {
          const n = await classifyItems(msg.tabId);
          sendResponse({ ok: true, probed: n });
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

    case 'JOB_STAGE':
    case 'JOB_PROGRESS':
    case 'JOB_READY':
    case 'JOB_ERROR':
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
    await clearRefererRule(jobId);
  } else if (msg.type === 'JOB_READY') {
    try {
      const downloadId = await chrome.downloads.download({
        url: msg.blobUrl,
        filename: msg.filename,
        saveAs: false
      });
      trackedDownloads.set(downloadId, { jobId, ruleKey: jobId, blobUrl: msg.blobUrl });
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
      await clearRefererRule(jobId);
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
