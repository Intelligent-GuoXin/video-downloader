import { humanSize, humanDuration, hostOf } from './lib/media.js';

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
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render(state) {
  const items = (state.tab && state.tab.items) || [];
  const page = state.page || {};
  const tab = state.tab || {};

  els.site.textContent = page.title || tab.title || page.url || tab.url || '未获取到页面信息';

  const drmOn = Boolean(tab.drm);
  els.drm.classList.toggle('hidden', !drmOn);
  if (drmOn) {
    els.drm.textContent =
      `本页启用了 DRM 加密（${tab.drmKeySystem || 'Widevine / EME'}）。` +
      'Netflix、Disney+、Prime Video 这类内容在浏览器里无法解密导出，本插件不会尝试绕过。';
  }

  renderJobPanel(currentJob);

  els.list.replaceChildren(...items.map((item) => renderItem(item)));

  const n = items.length;
  els.count.textContent = n ? `共 ${n} 个资源` : '';
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
  els.jobStage.textContent = job.stage || '处理中';
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
    const btn = document.createElement('button');
    btn.textContent = '下载';
    btn.disabled = busy;
    btn.addEventListener('click', () => startDirect(btn, item));
    actions.appendChild(btn);
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

async function startDirect(btn, item) {
  btn.disabled = true;
  const res = await ask({ type: 'DOWNLOAD_DIRECT', tabId, itemId: item.id });
  if (!res || !res.ok) {
    btn.disabled = false;
    alert(`下载失败：${(res && res.error) || '未知错误'}`);
    return;
  }
  btn.textContent = '已加入下载';
  setTimeout(() => {
    btn.textContent = '下载';
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
  await refresh();
})();
