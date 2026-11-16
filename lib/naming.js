/**
 * 下载文件命名。此前 background.js / offscreen.js 各写了一份，
 * 行为已经出现细微分叉 —— 统一到这里，改一处就全局生效。
 */

import { hostOf, sanitizeName } from './media.js';

/**
 * @param {object} opts
 * @param {string} opts.pageUrl  页面地址（用来推断站点目录名）
 * @param {string} opts.url      媒体地址（pageUrl 缺失时的兜底）
 * @param {string} opts.title    页面 / 条目标题（优先做文件名）
 * @param {string} opts.host     已知的站点名（HLS 任务里由调用方算好）
 * @param {string} opts.uniq     短 id，避免同标题文件互相覆盖
 * @param {string} opts.ext      扩展名（不含点）
 */
export function buildFilename({ pageUrl = '', url = '', title = '', host = '', uniq = '', ext = 'mp4' }) {
  const site = sanitizeName(host || hostOf(pageUrl || url) || 'video', 'site');
  const base = sanitizeName(title || site, 'video');
  const tag = uniq ? `-${uniq}` : '';
  return `视频嗅探/${site}/${base}${tag}.${ext}`;
}
