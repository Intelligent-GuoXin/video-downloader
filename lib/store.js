/**
 * 基于 chrome.storage.session 的状态存储。
 * MV3 的 Service Worker 会被随时回收，所有跨事件的检测结果必须落在这里，不能放内存变量。
 */

const TAB_PREFIX = 'tab:';
const JOB_PREFIX = 'job:';
const ACTIVE_JOB_PREFIX = 'active_job:';
const SETTINGS_KEY = 'settings';

/** 访问级别：扩展页面（SW / popup / offscreen）可读写，内容脚本读不到，符合最小权限 */
const AREA = chrome.storage.session;

export function emptyTab(tabId, url = '', title = '') {
  return { tabId, url, title, items: {}, touched: Date.now() };
}

export async function getTab(tabId) {
  const key = TAB_PREFIX + tabId;
  const obj = await AREA.get(key);
  return obj[key] || null;
}

export async function setTab(state) {
  const next = { ...state, touched: Date.now() };
  await AREA.set({ [TAB_PREFIX + state.tabId]: next });
  return next;
}

export async function clearTab(tabId) {
  await AREA.remove(TAB_PREFIX + tabId);
}

export async function listTabs() {
  const all = await AREA.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(TAB_PREFIX))
    .map(([, v]) => v);
}

/** 删除超过 maxAgeMs 未更新的 tab 状态，避免 session 配额被撑满 */
export async function pruneTabs(maxAgeMs = 3 * 60 * 60 * 1000) {
  const now = Date.now();
  const stale = (await listTabs())
    .filter((t) => now - (t.touched || 0) > maxAgeMs)
    .map((t) => TAB_PREFIX + t.tabId);
  if (stale.length) await AREA.remove(stale);
  return stale.length;
}

export async function setJob(job) {
  await AREA.set({ [JOB_PREFIX + job.id]: job });
  if (job.tabId != null) {
    await AREA.set({ [ACTIVE_JOB_PREFIX + job.tabId]: job.id });
  }
  return job;
}

export async function getJob(id) {
  const key = JOB_PREFIX + id;
  const obj = await AREA.get(key);
  return obj[key] || null;
}

export async function patchJob(id, patch) {
  const job = await getJob(id);
  if (!job) return null;
  const next = { ...job, ...patch };
  await AREA.set({ [JOB_PREFIX + id]: next });
  return next;
}

export async function getActiveJob(tabId) {
  const key = ACTIVE_JOB_PREFIX + tabId;
  const obj = await AREA.get(key);
  const id = obj[key];
  return id ? getJob(id) : null;
}

export async function clearActiveJob(tabId) {
  await AREA.remove(ACTIVE_JOB_PREFIX + tabId);
}

export async function getSettings() {
  const obj = await AREA.get(SETTINGS_KEY);
  return { autoProbe: true, concurrency: 6, ...(obj[SETTINGS_KEY] || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await AREA.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * 诊断信息（如 ffmpeg 引擎自检结果）。
 * 走 storage 而不是消息回执：长耗时任务的 sendResponse 通道不可靠，
 * 而且 Service Worker 随时可能被回收。
 */
const DIAG_PREFIX = 'diag:';

export async function setDiag(name, value) {
  await AREA.set({ [DIAG_PREFIX + name]: value });
}

export async function getDiag(name) {
  const obj = await AREA.get(DIAG_PREFIX + name);
  return obj[DIAG_PREFIX + name] || null;
}
