/**
 * Referer 注入规则（declarativeNetRequest 会话规则）。
 *
 * 背景：部分 CDN（抖音 douyinvod.com 等）按 Referer 白名单判权，缺了直接 403。
 * MV3 里 webRequest 不能改写请求头，只能用 DNR 的会话规则。
 *
 * 早期版本写死一条 ID 9001 的全局规则，多标签页并发时后者会覆盖前者的 Referer，
 * 先跑的任务立刻开始 403。这里改成：每个任务一条规则，按媒体文件所在域名限定
 * 作用范围，任务结束只摘自己那一条。
 *
 * 已知限制（实测）：`chrome.downloads.download()` 发出的请求不吃这些规则，
 * 只有扩展上下文（offscreen / SW）里的 fetch 受影响 —— 所以「需要 Referer 的直链」
 * 必须走 offscreen 抓取路径，见 jobs/direct.js。
 */

const REFERER_RULE_ID = 9001;
const MAX_REFERER_RULES = 20;

/**
 * Referer 规则要覆盖的资源类型。
 *
 * - xmlhttprequest：HLS 分片是 offscreen 里的 fetch
 * - media：<video> 直接播放的情况
 * - other：历史上给 chrome.downloads 留的（实测对下载请求不生效，保留无害）
 */
const REFERER_RESOURCE_TYPES = ['xmlhttprequest', 'media', 'other', 'object'];

/** key -> { host, referer }。键通常是 jobId；直链下载没有 job 时用临时键。 */
const refererRules = new Map();
let refererRuleIds = [];

function buildRefererRules() {
  const rules = [];
  const seenHost = new Set();
  let id = REFERER_RULE_ID;
  // 同一域名只留一条（后加入的任务优先），避免两条规则争同一个头
  for (const entry of [...refererRules.values()].reverse()) {
    if (!entry.host || seenHost.has(entry.host)) continue;
    if (id >= REFERER_RULE_ID + MAX_REFERER_RULES) break;
    seenHost.add(entry.host);
    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: entry.referer }]
      },
      condition: { urlFilter: `||${entry.host}`, resourceTypes: REFERER_RESOURCE_TYPES }
    });
  }
  return rules;
}

async function syncRefererRules() {
  const removeRuleIds = refererRuleIds;
  const addRules = buildRefererRules();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    refererRuleIds = addRules.map((r) => r.id);
  } catch {
    /* 规则失败不该拖垮下载 */
  }
}

/** 给某个媒体地址挂上「Referer = pageUrl」的会话规则，任务结束记得 clear。 */
export async function applyRefererRule(key, mediaUrl, pageUrl) {
  let host = '';
  try {
    host = new URL(mediaUrl).hostname;
  } catch {
    return false;
  }
  if (!pageUrl || !host) return false;
  refererRules.set(key, { host, referer: pageUrl });
  await syncRefererRules();
  return true;
}

/**
 * 摘掉一条规则。音轨是单独一条规则（键后缀 :a），一并摘掉，
 * 避免调用方还要记着清两条。
 */
export async function clearRefererRule(key) {
  const had = refererRules.delete(key) || refererRules.delete(key + ':a');
  if (!had) return;
  await syncRefererRules();
}

/** 诊断 / 测试用：当前活跃的规则键 */
export function activeRefererKeys() {
  return [...refererRules.keys()];
}
