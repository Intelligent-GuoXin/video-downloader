import { humanSize, humanDuration, hostOf } from './lib/media.js';
import { trackLabel } from './lib/mp4probe.js';

const $ = (id) => document.getElementById(id);
const els = {
  site: $('site'),
  drm: $('drm'),
  list: $('list'),
  empty: $('empty'),
  emptyText: $('empty-text'),
  count: $('count'),
  clear: $('clear'),
  rescan: $('rescan'),
  job: $('job'),
  jobStage: $('job-stage'),
  jobPct: $('job-pct'),
  jobBar: $('job-bar'),
  jobSize: $('job-size'),
  jobCancel: $('job-cancel')
};

const KIND_LABEL = { hls: 'HLS', dash: 'DASH', direct: '直链', audio: '音频' };
const SOURCE_LABEL = { dom: '页面元素', net: '网络请求', fetch: 'fetch', xhr: 'XHR', link: '页面链接' };
const TERMINAL_STAGES = new Set(['已完成', '失败', '已取消', '下载被中断']);

let tabId = null;
let segTabId = null;
let currentJob = null;
let pollTimer = null;
/** 当前页面上「仅音频」的条目，用来给「仅视频」的条目配对合并 */
let audioPool = [];

// ---------------------------------------------------------------------------
// 与 Service Worker 通信
// ---------------------------------------------------------------------------

function ask(payload) {
  return chrome.runtime.sendMessage(payload).catch(() => null);
}

async function refresh() {
  if (tabId == null) return;
  const res = await ask({ type: 'GET_STATE', tabId });
  if (!res || !res.ok) return;

  const job = res.job || null;
  const finished = !job || TERMINAL_STAGES.has(job.stage);

  if (finished) {
    if (currentJob && job && job.stage === '失败') {
      alert(`下载失败：${job.error || '未知错误'}`);
    }
    currentJob = null;
    stopPolling();
  } else {
    currentJob = job;
    startPolling();
  }

  render(res);

  // 直链条目要探过才知道是「仅视频 / 仅音频 / 音视频」。首屏拿到的是未探测的
  // 状态，补一次分类后重画，用户才能看到该不该配音频一起下。
  if (needsClassify(res.tab)) {
    const r = await ask({ type: 'CLASSIFY_ITEMS', tabId });
    if (r && r.ok && r.probed) {
      const again = await ask({ type: 'GET_STATE', tabId });
      if (again && again.ok) render(again);
    }
  }
}

function needsClassify(tab) {
  const items = (tab && tab.items) || [];
  return items.some((it) => !it.trackProbed && (it.kind === 'direct' || it.kind === 'audio'));
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render(state) {
  const raw = (state.tab && state.tab.items) || [];
  const page = state.page || {};
  const tab = state.tab || {};

  // 排序优先级：正在播放（内容脚本按「喂流关系 + 播放器状态」确认的那条）
  // > 最近还在被请求 > 最近请求时间倒序。
  //
  // 只按 lastSeen 排是不够的：短视频（十几秒）开场就缓冲完了，之后一直安静；
  // 而信息流页面同时在预加载下一条视频，它的请求一直在更新 lastSeen，
  // 结果排最前面的反而是「下一条」，一点下载就下错。
  const now = Date.now();
  const isLive = (x) => now - (x.lastSeen || x.ts || 0) < 10000;
  const items = [...raw].sort((a, b) => {
    const playing = Number(Boolean(b.playing)) - Number(Boolean(a.playing));
    if (playing) return playing;
    const live = Number(isLive(b)) - Number(isLive(a));
    if (live) return live;
    return (b.lastSeen || b.ts || 0) - (a.lastSeen || a.ts || 0);
  });

  els.site.textContent = page.title || tab.title || page.url || tab.url || '未获取到页面信息';

  const drmOn = Boolean(tab.drm);
  els.drm.classList.toggle('hidden', !drmOn);
  if (drmOn) {
    els.drm.textContent =
      `本页启用了 DRM 加密（${tab.drmKeySystem || 'Widevine / EME'}）。` +
      'Netflix、Disney+、Prime Video 这类内容在浏览器里无法解密导出，本插件不会尝试绕过。';
  }

  renderJobPanel(currentJob);

  // 音视频分离下发的站点：先把「仅音频」那几条挑出来，渲染时给视频条目配对
  audioPool = items.filter((it) => it.tracks && it.tracks.audio && !it.tracks.video);

  els.list.replaceChildren(...items.map((item) => renderItem(item)));

  const n = items.length;
  els.count.textContent = n ? `共 ${n} 个资源 · 正在播放优先` : '';
  els.empty.classList.toggle('hidden', n > 0 || currentJob !== null);
  if (n === 0) {
    els.emptyText.textContent = tab.mse
      ? '这个页面用的是分片流播放器，还没捕获到分片请求。'
      : '这个页面还没有嗅探到视频。';
  }

  els.clear.disabled = n === 0;
}

function renderJobPanel(job) {
  if (!job) {
    els.job.classList.add('hidden');
    return;
  }
  els.job.classList.remove('hidden');
  // 失败时把原因留在面板上：只显示「失败」两个字，用户不知道是链接过期、
  // 下载中断还是编码不支持，只能反复重试。
  if (job.error) {
    els.jobStage.textContent = job.error;
    els.jobStage.title = job.error;
  } else {
    els.jobStage.textContent = job.stage || '处理中';
    els.jobStage.title = '';
  }
  els.jobPct.textContent = `${job.progress || 0}%`;
  els.jobBar.style.width = `${job.progress || 0}%`;
  els.jobSize.textContent = job.total ? `分片 ${job.received || 0}/${job.total}` : '';
}

function fileNameOf(url) {
  const raw = String(url).split('?')[0].split('#')[0].split('/').pop() || '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function metaChips(item) {
  const chips = [];
  // 正在播放：内容脚本确认「这条流正被喂进当前播放器」。预加载的条目永远拿不到。
  if (item.playing) chips.push('▶ 正在播放');
  // 最近还在被请求 → 多半就是眼前正在播的那条。给个相对时间，
  // 用户才能在一堆预加载条目里认出「刚才播的那个」。
  const age = Date.now() - (item.lastSeen || item.ts || 0);
  if (!item.playing && age < 10000) chips.push('刚刚请求');
  else if (age < 3600000) chips.push(age < 60000 ? `${Math.round(age / 1000)} 秒前` : `${Math.round(age / 60000)} 分钟前`);
  // 轨道构成放最前：它决定这个条目能不能单独用
  const tl = trackLabel(item.tracks);
  if (tl) chips.push(tl);
  if (item.size) chips.push(humanSize(item.size));
  if (item.duration) chips.push(humanDuration(item.duration));
  if (item.width && item.height) chips.push(`${item.width}×${item.height}`);
  if (item.isMaster && item.variants) chips.push(`${item.variants.length} 种清晰度`);
  else if (item.segmentCount) chips.push(`${item.segmentCount} 个分片`);
  if (item.encrypted) chips.push('AES-128');
  if (item.isFmp4) chips.push('fMP4');
  if (item.isLive) chips.push('直播');
  if (item.source && SOURCE_LABEL[item.source]) chips.push(SOURCE_LABEL[item.source]);
  return chips;
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'item';

  const top = document.createElement('div');
  top.className = 'item-top';

  const badge = document.createElement('span');
  badge.className = 'badge';
  if (item.kind === 'hls') badge.className = 'badge warn';
  if (item.kind === 'audio') badge.className = 'badge ok';
  badge.textContent = KIND_LABEL[item.kind] || item.kind;
  top.appendChild(badge);

  const title = document.createElement('span');
  title.className = 'item-title';
  title.textContent = item.title || fileNameOf(item.url) || '未命名';
  title.title = title.textContent;
  top.appendChild(title);
  li.appendChild(top);

  const urlEl = document.createElement('div');
  urlEl.className = 'item-url';
  urlEl.textContent = item.url;
  urlEl.title = item.url;
  li.appendChild(urlEl);

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  for (const c of metaChips(item)) {
    const s = document.createElement('span');
    s.textContent = c;
    meta.appendChild(s);
  }
  li.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const busy = currentJob !== null;

  if (item.kind === 'hls' || item.kind === 'dash') {
    if (item.isMaster && item.variants && item.variants.length) {
      const sel = document.createElement('select');
      sel.dataset.role = 'variant';
      item.variants.forEach((v, idx) => {
        const o = document.createElement('option');
        o.value = v.url;
        const bw = v.bandwidth ? ` · ${(v.bandwidth / 1000).toFixed(0)}kbps` : '';
        o.textContent = (v.label || `线路 ${idx + 1}`) + bw;
        sel.appendChild(o);
      });
      sel.disabled = busy;
      actions.appendChild(sel);
    }

    const fmt = document.createElement('select');
    fmt.dataset.role = 'format';
    for (const [val, label] of [
      ['mp4', 'MP4 合流'],
      ['ts', 'TS 直出（快）']
    ]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      fmt.appendChild(o);
    }
    fmt.disabled = busy;
    actions.appendChild(fmt);

    const btn = document.createElement('button');
    const unsupported = item.kind === 'dash';
    btn.textContent = unsupported ? 'DASH 暂不支持' : '下载';
    btn.disabled = busy || unsupported;
    if (!unsupported) btn.addEventListener('click', () => startHls(li, item));
    actions.appendChild(btn);
  } else {
    // 只有视频轨、页面里又有单独的音频轨 → 默认下「视频+音频」并合并，
    // 否则用户拿到的是没声音的画面（抖音就是这么下发的）
    const videoOnly = Boolean(item.tracks && item.tracks.video && !item.tracks.audio);
    const audioOnly = Boolean(item.tracks && item.tracks.audio && !item.tracks.video);
    const fragmented = Boolean(item.tracks && item.tracks.fragmented);

    // 配对必须看时长：一个搜索页里十几条视频，光看「有音频」就配，
    // 很容易把 A 的声音接到 B 画面上（音画不同步，甚至完全对不上）。
    // 规则（与后台合并时的硬校验一致）：
    // - 双方时长已知且差 ≤ 0.6s/1% → 自动配对；
    // - 音频候选时长未知 → 只放进下拉，由用户核对后手动选；
    // - 视频自身时长未知 → 不给配对（没有任何证据，宁可不配）。
    const durOf = (x) => (x && x.tracks && x.tracks.duration) || x.duration || 0;
    const myDur = durOf(item);
    const candidates = videoOnly ? audioPool.filter((a) => a.id !== item.id) : [];
    const pairWith = candidates.filter((a) => {
      const d = durOf(a);
      return Boolean(myDur && d) && Math.abs(d - myDur) <= Math.max(0.6, myDur * 0.01);
    });
    const unverified = myDur ? candidates.filter((a) => !durOf(a)) : [];

    if (fragmented && !item.tracks.video) {
      // 纯音频分片单独下没有任何意义
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '分片流·仅音频，通常不需要单独下';
      actions.appendChild(hint);

      const btn = document.createElement('button');
      btn.textContent = '分片流';
      btn.disabled = true;
      actions.appendChild(btn);
    } else if (fragmented) {
      // m4s 能完整下载，但播放器不认，下载后会转成标准 MP4
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '分片流：下载后自动转成标准 MP4';
      actions.appendChild(hint);

      const btn = document.createElement('button');
      btn.textContent = '下载（分片）';
      btn.disabled = busy;
      btn.addEventListener('click', () => startDirect(btn, item, []));
      actions.appendChild(btn);
    } else {
      if (pairWith.length > 1 || (pairWith.length === 0 && unverified.length > 1)) {
        const sel = document.createElement('select');
        sel.dataset.role = 'audio';
        for (const a of pairWith) {
          const o = document.createElement('option');
          o.value = a.id;
          const d = durOf(a);
          o.textContent = `音频 ${humanSize(a.size) || ''}${d ? ` · ${humanDuration(d)}` : ''}`.trim();
          sel.appendChild(o);
        }
        for (const a of unverified) {
          const o = document.createElement('option');
          o.value = a.id;
          o.textContent = `音频（时长未知，自行核对）${humanSize(a.size) ? ` · ${humanSize(a.size)}` : ''}`.trim();
          sel.appendChild(o);
        }
        sel.disabled = busy;
        actions.appendChild(sel);
      }

      const btn = document.createElement('button');
      btn.textContent = pairWith.length ? '下载（含音频）' : unverified.length ? '下载（含音频）' : '下载';
      btn.disabled = busy;
      btn.addEventListener('click', () => startDirect(btn, item, pairWith.length ? pairWith : unverified));
      actions.appendChild(btn);

      if (pairWith.length || unverified.length) {
        // 想只要画面时留个出口，避免被迫下载音轨
        const vOnly = document.createElement('button');
        vOnly.className = 'ghost';
        vOnly.textContent = '仅视频';
        vOnly.disabled = busy;
        vOnly.addEventListener('click', () => startDirect(vOnly, item, []));
        actions.appendChild(vOnly);
      }
    }

    if (videoOnly && !fragmented && !pairWith.length && !unverified.length) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = candidates.length
        ? '同页有音频，但时长对不上，不自动合并'
        : '没找到对应音轨，将只下载画面';
      actions.appendChild(hint);
    }

    if (videoOnly && !fragmented && !myDur && candidates.length) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '视频时长未知，无法自动配对；先播放完整再嗅探可补全';
      actions.appendChild(hint);
    }

    if (audioOnly) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '仅音频，通常不需要单独下';
      actions.appendChild(hint);
    }
  }

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  actions.appendChild(spacer);

  const rm = document.createElement('button');
  rm.className = 'ghost';
  rm.textContent = '移除';
  rm.disabled = busy;
  rm.addEventListener('click', async () => {
    await ask({ type: 'REMOVE_ITEM', tabId, itemId: item.id });
    refresh();
  });
  actions.appendChild(rm);

  li.appendChild(actions);
  return li;
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/**
 * @param pairWith 「仅音频」候选条目；非空时后台会把音轨一起抓下来并合并
 */
async function startDirect(btn, item, pairWith = []) {
  const label = btn.textContent;
  btn.disabled = true;

  let audioItemId = '';
  if (pairWith.length) {
    const sel = btn.closest('li')?.querySelector('select[data-role="audio"]');
    audioItemId = sel ? sel.value : pairWith[0].id;
  }

  const res = await ask({ type: 'DOWNLOAD_DIRECT', tabId, itemId: item.id, audioItemId });
  if (!res || !res.ok) {
    btn.disabled = false;
    alert(`下载失败：${(res && res.error) || '未知错误'}`);
    return;
  }
  btn.textContent = audioItemId ? '合并中…' : '已加入下载';
  setTimeout(() => {
    btn.textContent = label;
    btn.disabled = false;
  }, 2500);
}

async function startHls(li, item) {
  const variantSel = li.querySelector('select[data-role="variant"]');
  const fmtSel = li.querySelector('select[data-role="format"]');

  const variantUrl = variantSel ? variantSel.value : '';
  // master 里若用 EXT-X-MEDIA 分离了音轨，必须把音频播放列表一起带上，否则下出来是哑的
  const picked = (item.variants || []).find((v) => v.url === variantUrl);
  const audioUrl = picked ? picked.audioUrl || '' : '';

  const res = await ask({
    type: 'START_HLS_JOB',
    tabId,
    itemId: item.id,
    variantUrl,
    audioUrl,
    output: fmtSel ? fmtSel.value : 'mp4'
  });

  if (!res || !res.ok) {
    alert(`启动失败：${(res && res.error) || '未知错误'}`);
    return;
  }
  currentJob = res.job;
  startPolling();
  refresh();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refresh, 900);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

/** 轻量轮询：无任务时也让「正在播放」标记和排序跟着页面实际播放走 */
let idleTimer = null;
function startIdlePolling() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    // 用户正在列表里操作（下拉选择等）时不重画，免得把选择打断
    if (els.list.contains(document.activeElement)) return;
    void refresh();
  }, 2000);
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'popup') return;
  if (msg.type === 'JOB_UPDATE' && msg.job && tabId != null && msg.job.tabId === tabId) {
    refresh();
  }
});

els.rescan.addEventListener('click', async () => {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'FORCE_SCAN' });
  } catch {
    /* 内容脚本可能还没注入 */
  }
  await refresh();
});

els.clear.addEventListener('click', async () => {
  if (tabId == null) return;
  await ask({ type: 'CLEAR_TAB', tabId });
  refresh();
});

els.jobCancel.addEventListener('click', async () => {
  if (!currentJob) return;
  els.jobStage.textContent = '正在取消…';
  await ask({ type: 'CANCEL_JOB', jobId: currentJob.id });
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function init() {
  // 支持 popup.html#tab=<id> 手动指定标签页，便于把 popup 当普通页面打开调试
  const forced = /(?:^|[#&])tab=(\d+)/.exec(location.hash || '');
  let tab = null;

  if (forced) {
    tabId = Number(forced[1]);
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      els.site.textContent = `找不到标签页 ${tabId}`;
      return;
    }
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      els.site.textContent = '没有可用的标签页';
      return;
    }
    tabId = tab.id;
  }
  segTabId = tabId;

  if (!/^https?:/i.test(tab.url || '')) {
    els.site.textContent = `${hostOf(tab.url) || '浏览器内置页'} · 此页面类型不支持嗅探`;
    els.emptyText.textContent = '浏览器内置页面（chrome://、扩展页、新标签页）无法嗅探视频。';
    els.empty.classList.remove('hidden');
    els.rescan.disabled = true;
    els.clear.disabled = true;
    return;
  }

  els.site.textContent = tab.title || tab.url;
  startIdlePolling();
  await refresh();
})();
