/**
 * 端到端验证脚本：真实 Chrome + 加载已解压扩展 + 本地测试站点。
 *
 * 覆盖点：
 *  1. MV3 Service Worker 能否正常注册启动（不报错）
 *  2. 三路检测（DOM 扫描 / 网络嗅探 / MAIN world 插桩）是否都能拿到资源
 *  3. 「正在播放」标记：MSE 喂流关系 → 列表能把当前播放的那条顶到最前
 *  4. HLS master 解析、清晰度选择、AES-128 全链路
 *  5. Referer 白名单直链（模拟抖音 CDN 的 403）
 *  6. 分片流转标准 MP4 / 截断下载拦截
 *  6b. DASH 音视频分离自动配对（含「时长对不上的候选必须被跳过」）
 *  6c. 显式配对时长不符必须在合并前失败（防串轨的硬校验）
 *
 * 用法：node devtest/run.mjs
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer, REF_GATED_SIZE } from './server.mjs';
import { parseTrackKinds } from '../lib/mp4probe.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..');

/**
 * puppeteer-core 装在哪儿都行，这里按顺序探测。
 * ESM 的 import 不会向上查找 node_modules，所以必须用 createRequire 显式解析。
 * 优先读环境变量 VD_NODE_MODULES（可指向 node_modules 目录本身，也可指向其父目录）。
 */
function loadPuppeteer() {
  const normalizeBase = (p) => {
    if (!p) return null;
    const abs = path.resolve(p);
    return path.basename(abs) === 'node_modules' ? path.dirname(abs) : abs;
  };
  const candidates = [
    normalizeBase(process.env.VD_NODE_MODULES),
    HERE, // devtest/node_modules —— 在 devtest 里 npm i 的情况
    path.resolve(HERE, '..') // video-downloader/node_modules —— 在插件根目录 npm i 的情况
  ].filter(Boolean);

  for (const base of candidates) {
    try {
      return createRequire(path.join(base, 'probe.cjs'))('puppeteer-core');
    } catch {
      /* 换下一个候选路径 */
    }
  }
  throw new Error(
    '未找到 puppeteer-core。请在 devtest 目录执行 `npm i -D puppeteer-core`，' +
      '或用 VD_NODE_MODULES=/path/to/node_modules 指定位置。'
  );
}

const puppeteer = loadPuppeteer();

const PORT = 8899;
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
/** 默认路径按平台猜，猜不到就用 VD_CHROME 指定 */
const DEFAULT_CHROME =
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : 'google-chrome';
const CHROME = process.env.VD_CHROME || DEFAULT_CHROME;

/**
 * 额外启动参数。受限环境（容器 / CI / 某些沙箱）里 Chrome 的沙箱起不来，
 * 表现为 GPU 进程退出码 6、network service 反复重启，最后整体崩掉。
 * 这时用 VD_CHROME_ARGS="--no-sandbox --disable-gpu" 兜底。
 */
const EXTRA_ARGS = (process.env.VD_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
const PROFILE = path.join(os.tmpdir(), 'vd-ext-profile');
const DOWNLOADS = path.join(os.tmpdir(), 'vd-ext-downloads');

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (cond, name) => {
  results.push({ name, pass: Boolean(cond) });
  log(`${cond ? '  ✅' : '  ❌'} ${name}`);
};

async function main() {
  // 关键：必须清掉 profile。否则 Chrome 会复用上一次装进去的扩展代码，
  // 改了源码却测的是旧版本（会表现为诡异的现象：老的消息类型能回、新加的不能）。
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const server = await startServer(PORT);
  log(`\n[1] 测试站点已启动 ${PAGE_URL}`);

  // 注意：Chrome 137+ 已禁止用 --load-extension 命令行装载扩展（自动化场景），
  // 改用 CDP 的 Extensions.loadUnpacked（需 --enable-unsafe-extension-debugging + pipe）。
  // 另外 puppeteer 默认会注入 --disable-extensions，必须用 ignoreDefaultArgs 摘掉。
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    userDataDir: PROFILE,
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', ...EXTRA_ARGS]
  });

  const swErrors = [];
  const swLogs = [];
  let extId = '';

  try {
    // ---- 2. 加载扩展，检查 SW ----
    log('\n[2] 加载扩展并检查 Service Worker');
    const rootSession = await browser.target().createCDPSession();
    ({ id: extId } = await rootSession.send('Extensions.loadUnpacked', { path: EXT_DIR }));
    log(`    扩展 ID: ${extId}`);

    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes(extId),
      { timeout: 20000 }
    );
    const worker = await swTarget.worker();
    check(!!worker, 'Service Worker 已注册并启动');

    const swCdp = await swTarget.createCDPSession();
    await swCdp.send('Runtime.enable');
    swCdp.on('Runtime.exceptionThrown', (e) => {
      swErrors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text || 'unknown');
    });
    swCdp.on('Runtime.consoleAPICalled', (e) => {
      swLogs.push(`[${e.type}] ${(e.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
    });

    // ---- 3. 打开测试页 ----
    log('\n[3] 打开测试页，等待嗅探');
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    try {
      const cdpPage = await page.createCDPSession();
      await cdpPage.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
    } catch (e) {
      log(`    （无法设置下载目录：${e.message}）`);
    }

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await sleep(4000);

    check(await page.evaluate(() => Boolean(window.__vdsniffer_hooked__)), 'MAIN world 插桩脚本已注入');
    check(pageErrors.length === 0, `测试页无 JS 报错${pageErrors.length ? `（${pageErrors[0]}）` : ''}`);

    const tabId = await worker.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({ url: u });
      return tabs.length ? tabs[0].id : null;
    }, PAGE_URL);
    check(tabId != null, `定位到测试页标签（tabId=${tabId}）`);

    const readState = () =>
      worker.evaluate(async (id) => {
        const o = await chrome.storage.session.get('tab:' + id);
        return o['tab:' + id] || null;
      }, tabId);

    const state = await readState();
    const items = state ? Object.values(state.items) : [];
    log(`\n    嗅探结果（${items.length} 条）:`);
    for (const it of items) {
      const extra = it.isMaster ? ' | master' : it.segmentCount ? ` | ${it.segmentCount} 段` : '';
      log(`      [${it.kind}] ${it.source.padEnd(6)} ${it.url}${extra}`);
    }

    check(items.length > 0, '检测到视频资源');
    check(items.some((i) => i.url.includes('sample.mp4')), '检测到 <video src> 直链');
    check(items.some((i) => i.url.includes('link-target.mp4')), '检测到页面链接里的直链');
    check(items.some((i) => i.kind === 'hls'), '检测到 HLS（.m3u8）');
    check(
      items.some((i) => i.url.includes('fetched-by-page.mp4')) &&
        items.some((i) => i.url.includes('xhr-by-page.webm')),
      'MAIN world 插桩命中页面自身发起的 fetch / XHR'
    );

    const hls = items.find((i) => i.url.includes('master.m3u8'));
    check(!!hls && hls.isMaster && hls.variants.length === 2, 'HLS master 解析出 2 档清晰度');
    if (hls) log(`      清晰度: ${hls.variants.map((v) => v.label).join(', ')}`);

    // ---- 4. 从 popup 界面发起下载 ----
    log('\n[4] 打开 popup（#tab 调试入口）并从界面点下载');
    const popup = await browser.newPage();
    popup.on('dialog', async (d) => {
      log(`      [popup 弹窗] ${d.message()}`);
      await d.dismiss();
    });
    popup.on('pageerror', (e) => log(`      [popup error] ${e.message}`));

    await popup.goto(`chrome-extension://${extId}/popup.html#tab=${tabId}`, {
      waitUntil: 'domcontentloaded'
    });
    await sleep(1800);

    const popupText = await popup.evaluate(() => document.body.innerText);
    log(`      popup 渲染文本: ${JSON.stringify(popupText.replace(/\s+/g, ' ').slice(0, 160))}`);
    check(popupText.includes('master.m3u8') || popupText.includes('HLS'), 'popup 渲染出了嗅探列表');

    // 从 popup 页面发消息（Service Worker 给自己发消息收不到回执）
    const sendFromPopup = (payload) =>
      popup.evaluate(
        (p) =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage(p, (r) =>
              resolve(
                r || { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no response' }
              )
            );
            setTimeout(() => resolve({ ok: false, error: '回执超时' }), 30000);
          }),
        payload
      );

    // ---- 4b. 轨道识别：音视频分离下发的站点要能配对 ----
    // 服务端给的 vonly / aonly 是带真实 moov 的合成 MP4，只有一条轨。
    // 探测是 popup 打开后异步做的，这里等它落盘（最多 6 秒）。
    let trackState = await readState();
    for (let i = 0; i < 12; i += 1) {
      const list = trackState ? Object.values(trackState.items) : [];
      if (list.some((x) => x.url.includes('vonly') && x.tracks)) break;
      await sleep(500);
      trackState = await readState();
    }
    // 探测结果落盘后需要重画一次界面（popup 自己会重画，这里等一下）
    await sleep(600);

    const tItems = trackState ? Object.values(trackState.items) : [];
    const vonly = tItems.find((i) => i.url.includes('vonly'));
    const aonly = tItems.find((i) => i.url.includes('aonly'));
    if (!aonly) {
      log(`      条目清单: ${tItems.map((i) => `${i.kind}:${i.url.split('/').pop()}`).join(', ')}`);
    }
    check(
      Boolean(vonly && vonly.tracks && vonly.tracks.video && !vonly.tracks.audio),
      `认出「只有视频轨」的条目（${vonly ? JSON.stringify(vonly.tracks) : '未命中'}）`
    );
    check(
      Boolean(aonly && aonly.tracks && aonly.tracks.audio && !aonly.tracks.video),
      `认出「只有音频轨」的条目（${aonly ? JSON.stringify(aonly.tracks) : '未命中'}）`
    );

    const pairUi = await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('li.item')];
      const row = rows.find((r) => (r.querySelector('.item-url')?.textContent || '').includes('vonly'));
      if (!row) return { ok: false, why: 'no-row' };
      const btns = [...row.querySelectorAll('button')].map((b) => b.textContent);
      return { ok: true, meta: row.querySelector('.item-meta')?.textContent || '', btns };
    });
    check(
      pairUi.ok && pairUi.meta.includes('仅视频'),
      `视频条目标注了「仅视频」（${pairUi.ok ? pairUi.meta : pairUi.why}）`
    );
    check(
      pairUi.ok && pairUi.btns.includes('下载（含音频）'),
      `视频条目提供了「下载（含音频）」（按钮：${pairUi.ok ? pairUi.btns.join('/') : pairUi.why}）`
    );

    // ---- 4c. 「正在播放」标记（MSE 喂流关系）----
    // 信息流页面的坑：预加载的「下一条」也在请求媒体，光看请求时间分不清谁在播。
    // 这里模拟真实播放器：MediaSource 挂到 video、开始播放、fetch 一个媒体地址、
    // 然后把数据 appendBuffer 进去 —— 插桩应当把「sample.mp4 正在播放」报给后台。
    log('\n[4c] 正在播放标记（模拟 MSE 喂流）');
    await page.bringToFront(); // 后台页面的 MediaSource attach 会被浏览器推迟
    const feedDiag = await page.evaluate(async () => {
      const v = document.createElement('video');
      v.muted = true;
      const ms = new MediaSource();
      const blobUrl = URL.createObjectURL(ms);
      v.src = blobUrl;
      document.body.appendChild(v);
      v.play().catch(() => {}); // 无真实数据，play() 挂起但 paused = false
      // 等 sourceopen（事件驱动，不靠猜时间）
      await new Promise((resolve) => {
        if (ms.readyState === 'open') resolve();
        else ms.addEventListener('sourceopen', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
      await fetch('/media/sample.mp4', { method: 'HEAD' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
      let appended = false;
      try {
        if (ms.readyState === 'open') {
          const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
          sb.appendBuffer(new Uint8Array(8)); // 插桩在调用前就会完成「喂流」上报
          appended = true;
        }
      } catch (e) {
        return { appended: false, error: String(e) };
      }
      return { appended, readyState: ms.readyState, paused: v.paused };
    });
    if (!feedDiag.appended) log(`      ⚠️ 模拟播放器未完成 append：${JSON.stringify(feedDiag)}`);
    await sleep(1500);
    // PLAYING 的落盘要排队等 withTabLock（前面的批量轨道探测占着队列），轮询等它
    let playState = null;
    let sampleItem = null;
    for (let i = 0; i < 20; i += 1) {
      playState = await readState();
      sampleItem = playState
        ? Object.values(playState.items).find((it) => it.url.includes('sample.mp4'))
        : null;
      if (sampleItem && sampleItem.playing) break;
      await sleep(500);
    }
    const playItems = playState ? Object.values(playState.items) : [];
    const markedCount = playItems.filter((i) => i.playing).length;
    check(
      Boolean(sampleItem && sampleItem.playing),
      `喂流关系标记了正在播放的条目（${sampleItem ? `playing=${sampleItem.playing}` : '未找到条目'}）`
    );
    check(markedCount >= 1 && markedCount <= 2, `标记没有扩散到无关条目（共 ${markedCount} 条被标记）`);

    await sleep(3000); // 等 popup 的轻量轮询重画
    const playingUi = await popup.evaluate(() => document.body.innerText);
    check(playingUi.includes('正在播放'), 'popup 显示「正在播放」标记');

    const clickResult = await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('li.item')];
      const row = rows.find((r) => (r.querySelector('.item-url')?.textContent || '').includes('master.m3u8'));
      if (!row) return 'no-row';

      const vs = row.querySelector('select[data-role="variant"]');
      if (vs) {
        const opt = [...vs.options].find((o) => o.textContent.startsWith('720p'));
        if (opt) vs.value = opt.value;
      }
      const fs2 = row.querySelector('select[data-role="format"]');
      if (fs2) fs2.value = 'ts';

      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === '下载');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    });
    check(clickResult === 'clicked', `popup 下载按钮可点击（${clickResult}）`);

    let job = null;
    for (let i = 0; i < 50; i += 1) {
      await sleep(500);
      job = await worker.evaluate(async () => {
        const all = await chrome.storage.session.get(null);
        const key = Object.keys(all).find((k) => k.startsWith('job:'));
        return key ? all[key] : null;
      });
      if (job && ['已完成', '失败', '已取消'].includes(job.stage)) break;
    }
    log(`      任务终态: stage=${job && job.stage}  progress=${job && job.progress}%`);
    if (job && job.error) log(`      错误: ${job.error}`);
    check(job && job.stage === '已完成', 'HLS 任务跑完全流程');
    log(`      job.filename = ${job && job.filename}`);
    check(Boolean(job && /\.ts$/.test(job.filename || '')), '输出扩展名为 .ts（TS 直出）');

    await sleep(2500);
    const files = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];
    log(`\n    下载目录(${DOWNLOADS})  注：CDP 接管下载会把文件名改成 GUID`);
    for (const f of files) {
      log(`      ${f}  ${fs.statSync(path.join(DOWNLOADS, f)).size} bytes`);
    }
    check(files.length > 0, '文件已落盘');

    const expect = 16384 * 3 * 2; // 视频 3 段 + 独立音轨 3 段
    if (files.length) {
      const newest = files
        .map((f) => ({ f, mtime: fs.statSync(path.join(DOWNLOADS, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0].f;
      const out = fs.readFileSync(path.join(DOWNLOADS, newest));
      log(`      最新产物 ${newest} = ${out.length} bytes，期望 ${expect}（6 段 × 16384，已解密）`);
      check(out.length === expect, '视频轨 + 音轨共 6 个分片全部合入');
    }

    // ---- 5. Referer 白名单直链（抖音那类 CDN）----
    // 服务端对 /media/ref-gated.mp4 做 Referer 校验：请求没带页面 Referer 就 403。
    // chrome.downloads.download 自己不会带 Referer，只有扩展用 DNR 补上才能下成，
    // 校验点因此是「产物真的 12345 字节」而不是「点了没报错」。
    log('\n[5] Referer 白名单直链下载（模拟抖音 CDN 的 403 场景）');
    const beforeFiles = new Set(fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : []);

    const directClick = await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('li.item')];
      const row = rows.find((r) => (r.querySelector('.item-url')?.textContent || '').includes('ref-gated'));
      if (!row) return 'no-row';
      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === '下载');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    });
    check(directClick === 'clicked', `ref-gated 直链的下载按钮可点击（${directClick}）`);

    let gatedOk = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const now = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];
      const hit = now.find(
        (f) => !beforeFiles.has(f) && fs.statSync(path.join(DOWNLOADS, f)).size === REF_GATED_SIZE
      );
      if (hit) {
        gatedOk = true;
        break;
      }
    }
    const afterFiles = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];
    const newFiles = afterFiles.filter((f) => !beforeFiles.has(f));
    if (!gatedOk) log(`      新产物: ${newFiles.map((f) => `${f}=${fs.statSync(path.join(DOWNLOADS, f)).size}`).join(', ') || '（无）'}`);
    check(gatedOk, `Referer 白名单直链下载成功（产物 ${REF_GATED_SIZE} 字节，证明下载请求带上了 Referer）`);

    // 规则只在任务期间存在，下完必须摘掉，否则会污染后续所有同类请求
    const leftRules = await worker
      .evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).length)
      .catch(() => -1);
    check(leftRules === 0, `临时 Referer 规则已清理（残留 ${leftRules} 条）`);

    // ---- 6. 分片流识别 / 截断下载拦截 ----
    // 两个都是「文件看起来下完了、其实用不了」的坑：
    // - frag.mp4 是 fMP4 的 m4s，单独一条只有整段流的一小块；
    // - truncated.mp4 头里声明 512KB，实际只给 32KB（连接被掐断）。
    log('\n[6] 分片流转标准 MP4 / 截断下载拦截');
    await popup.evaluate(() => location.reload());
    await sleep(1800);

    const fragRow = await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('li.item')];
      const row = rows.find((r) => (r.querySelector('.item-url')?.textContent || '').includes('frag.mp4'));
      if (!row) return { found: false };
      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('下载'));
      return {
        found: true,
        text: btn ? btn.textContent : '',
        disabled: btn ? btn.disabled : true,
        meta: row.querySelector('.item-meta')?.textContent || ''
      };
    });
    check(fragRow.found, '列表里出现分片流条目');
    check(
      fragRow.text.includes('分片') && !fragRow.disabled,
      `分片流条目可以下载（按钮：${fragRow.text || '无'}）`
    );

    // 点它：服务端给的是结构完整的 fMP4（moof + trun 带 data_offset），
    // 扩展必须把它转成 moov 前置的标准 MP4，否则产物 `<video src>` 打不开。
    const beforeFrag = new Set(fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : []);
    await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('li.item')];
      const row = rows.find((r) => (r.querySelector('.item-url')?.textContent || '').includes('frag.mp4'));
      const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.includes('下载'));
      if (btn) btn.click();
    });

    let fragJob = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(250);
      const all = await worker.evaluate(async () => await chrome.storage.session.get(null));
      const jobs = Object.keys(all)
        .filter((k) => k.startsWith('job:'))
        .map((k) => all[k])
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      fragJob = jobs[0] || null;
      if (fragJob && ['已完成', '失败', '已取消'].includes(fragJob.stage)) break;
    }
    check(fragJob && fragJob.stage === '已完成', `分片流任务完成（stage=${fragJob?.stage} ${fragJob?.error || ''}）`);

    await sleep(1200);
    const afterFrag = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];
    const fragOut = afterFrag.filter((f) => !beforeFrag.has(f));
    check(fragOut.length > 0, '分片流产物已落盘');

    if (fragOut.length) {
      const outPath = path.join(DOWNLOADS, fragOut[0]);
      const buf = fs.readFileSync(outPath);
      const tracks = parseTrackKinds(new Uint8Array(buf.subarray(0, Math.min(65536, buf.length))));
      log(`      产物 ${fragOut[0]}: ${buf.length} 字节, ${JSON.stringify(tracks)}`);
      check(Boolean(tracks && tracks.video), '产物是完整 MP4（能解析出 moov）');
      check(Boolean(tracks && !tracks.fragmented), '产物已从分片流转成标准 MP4（moov 里有样本表）');
    }

    const beforeTrunc = new Set(fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : []);
    const jobsBefore = new Set(
      Object.keys(await worker.evaluate(async () => await chrome.storage.session.get(null))).filter((k) =>
        k.startsWith('job:')
      )
    );
    const truncClick = await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('li.item')];
      const row = rows.find((r) => (r.querySelector('.item-url')?.textContent || '').includes('truncated'));
      if (!row) return 'no-row';
      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === '下载');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    });
    check(truncClick === 'clicked', `截断下载的按钮可点击（${truncClick}）`);

    let truncJob = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(250);
      const all = await worker.evaluate(async () => await chrome.storage.session.get(null));
      // 只认这次点击新冒出来的 job：上一段的 HLS 任务还躺在 storage 里
      const key = Object.keys(all).find((k) => k.startsWith('job:') && !jobsBefore.has(k));
      truncJob = key ? all[key] : null;
      if (truncJob && ['失败', '已完成', '已取消'].includes(truncJob.stage)) break;
    }
    if (truncJob && truncJob.stage !== '失败') log(`      任务信息: ${JSON.stringify(truncJob).slice(0, 240)}`);
    check(Boolean(truncJob) && truncJob.stage === '失败', `截断下载判定为失败（stage=${truncJob?.stage}）`);
    check(
      Boolean(truncJob && /不完整|中断|长度|fetch/i.test(truncJob.error || '')),
      `失败原因指向「下载不完整」（${truncJob?.error || '无'}）`
    );

    const afterTrunc = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];
    const truncLeak = afterTrunc.filter((f) => !beforeTrunc.has(f));
    if (truncLeak.length) log(`      意外的产物: ${truncLeak.join(', ')}`);
    check(truncLeak.length === 0, '截断的文件没有落盘（不会把残片当成功交付）');

    // ---- 6b. 抖音 DASH：视频流 + 音频流分开下发，点视频要自动合并 ----
    // 服务端给 /dash/v.mp4（仅视频 fMP4，2 秒）、/dash/a.mp4（仅音频 fMP4，2 秒）
    // 和 /dash/a-short.mp4（仅音频 fMP4，4 秒 —— 模拟别条视频的音轨混进同一页）。
    // 用户只点视频那条：下载 → 转成标准 MP4 → 发现只有画面 → 自动抓同页候选 →
    // 时长对不上的必须跳过 → 认出纯音轨且时长匹配 → 合并成一个文件交付。
    log('\n[6b] DASH 音视频分离：点视频流应自动配上时长一致的音轨');
    await page.reload({ waitUntil: 'domcontentloaded' }); // 刷新候选的「最近请求」时间
    await sleep(3000);
    await popup.evaluate(() => location.reload());
    await sleep(1800);

    const beforeDash = new Set(fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : []);
    const dashClick = await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('li.item')];
      const row = rows.find((r) => (r.querySelector('.item-url')?.textContent || '').includes('/dash/v.mp4'));
      if (!row) return 'no-row';
      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('下载'));
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    });
    check(dashClick === 'clicked', `DASH 视频流的下载按钮可点击（${dashClick}）`);

    let dashJob = null;
    for (let i = 0; i < 120; i += 1) {
      await sleep(250);
      const all = await worker.evaluate(async () => await chrome.storage.session.get(null));
      const jobs = Object.keys(all)
        .filter((k) => k.startsWith('job:'))
        .map((k) => all[k])
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      dashJob = jobs[0] || null;
      if (dashJob && ['已完成', '失败', '已取消'].includes(dashJob.stage)) break;
    }
    check(dashJob && dashJob.stage === '已完成', `DASH 任务完成（stage=${dashJob?.stage} ${dashJob?.error || ''}）`);
    log(`      stage: ${dashJob?.stage}`);

    await sleep(1500);
    const afterDash = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];
    const dashOut = afterDash.filter((f) => !beforeDash.has(f));
    check(dashOut.length > 0, 'DASH 产物已落盘');

    if (dashOut.length) {
      const outPath = path.join(DOWNLOADS, dashOut[0]);
      const buf = fs.readFileSync(outPath);
      const tracks = parseTrackKinds(new Uint8Array(buf.subarray(0, Math.min(65536, buf.length))));
      log(`      产物 ${dashOut[0]}: ${buf.length} 字节, ${JSON.stringify(tracks)}`);
      check(Boolean(tracks && tracks.video && tracks.audio), '产物同时含视频轨和音频轨（自动配对成功）');
      check(Boolean(tracks && !tracks.fragmented), '产物是标准 MP4');
      // 关键断言：合并的是「时长一致」的 a.mp4（2 秒），而不是混进来的
      // 4 秒候选 a-short.mp4 —— 串轨的产物总时长会变成 4 秒。
      check(
        Boolean(tracks && tracks.duration > 1.5 && tracks.duration < 2.5),
        `配对按时长硬校验（产物时长 ${tracks ? tracks.duration.toFixed(2) : '?'} 秒 ≈ 视频的 2 秒，不是错误候选的 4 秒）`
      );
    }

    // ---- 6c. 显式配对时长不符必须在合并前失败 ----
    // frag.mp4（2 秒）+ a-short.mp4（4 秒）：早期版本会盲目合并出一个
    // 「画面 2 秒、声音 4 秒」的错位文件 —— 这就是「总是下错视频」的安静版本。
    // 现在必须在合并前发现时长对不上并拒绝交付。
    log('\n[6c] 时长不符的显式配对必须被拒绝（防串轨硬校验）');
    const ids = await worker.evaluate(async (id) => {
      const o = await chrome.storage.session.get('tab:' + id);
      const st = o['tab:' + id] || null;
      if (!st) return {};
      const find = (needle) => {
        const it = Object.values(st.items).find((i) => i.url.includes(needle));
        return it ? it.id : '';
      };
      return { frag: find('frag.mp4'), short: find('a-short') };
    }, tabId);
    check(Boolean(ids.frag && ids.short), `拿到两条待配对条目（frag=${ids.frag} short=${ids.short}）`);

    const jobsBefore6c = new Set(
      Object.keys(await worker.evaluate(async () => await chrome.storage.session.get(null))).filter((k) =>
        k.startsWith('job:')
      )
    );
    const before6c = new Set(fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : []);

    const mismatchRes = await sendFromPopup({
      type: 'DOWNLOAD_DIRECT',
      tabId,
      itemId: ids.frag,
      audioItemId: ids.short
    });
    check(
      Boolean(mismatchRes && mismatchRes.ok),
      `时长不符的配对任务已受理（${JSON.stringify(mismatchRes).slice(0, 120)}）`
    );

    let mismatchJob = null;
    for (let i = 0; i < 100; i += 1) {
      await sleep(250);
      const all = await worker.evaluate(async () => await chrome.storage.session.get(null));
      const key = Object.keys(all).find((k) => k.startsWith('job:') && !jobsBefore6c.has(k));
      mismatchJob = key ? all[key] : null;
      if (mismatchJob && ['失败', '已完成', '已取消'].includes(mismatchJob.stage)) break;
    }
    check(
      Boolean(mismatchJob && mismatchJob.stage === '失败'),
      `时长不符的配对被判定失败（stage=${mismatchJob?.stage}）`
    );
    check(
      Boolean(mismatchJob && /时长/.test(mismatchJob.error || '')),
      `失败原因指向「时长对不上」（${mismatchJob?.error || '无'}）`
    );
    const leak6c = (fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : []).filter((f) => !before6c.has(f));
    check(leak6c.length === 0, '错位文件没有落盘');

    // ---- 7. 汇总：SW 日志与未捕获异常 ----
    log('\n[7] Service Worker 日志');
    // 把 console 监听挂到「当前」SW 实例上（SW 可能已经重启过，旧会话收不到日志）
    try {
      const liveTarget = await browser.waitForTarget(
        (t) => t.type() === 'service_worker' && t.url().includes(extId),
        { timeout: 10000 }
      );
      const liveCdp = await liveTarget.createCDPSession();
      await liveCdp.send('Runtime.enable');
      liveCdp.on('Runtime.consoleAPICalled', (e) =>
        swLogs.push(`[live] ${e.type} ${(e.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`)
      );
      liveCdp.on('Runtime.exceptionThrown', (e) =>
        swErrors.push(
          `[live] ${e.exceptionDetails?.exception?.description || e.exceptionDetails?.text || 'unknown'}`
        )
      );
      await sendFromPopup({ type: 'GET_STATE', tabId: null }); // 顺带预热
    } catch (e) {
      log(`    （附加日志监听失败：${e.message}）`);
    }

    log('\n[7] Service Worker 未捕获异常');
    if (swErrors.length) swErrors.slice(0, 5).forEach((e) => log('    ⚠️ ' + String(e).split('\n')[0]));
    else log('    （无）');
    swLogs.slice(-25).forEach((l) => log('    ' + l));

    log(`\n${'─'.repeat(58)}`);
    const passed = results.filter((r) => r.pass).length;
    log(`结果: ${passed}/${results.length} 项通过`);
    results.filter((r) => !r.pass).forEach((r) => log(`  未通过: ${r.name}`));
    log('─'.repeat(58));
    log(`\n手动验收：Chrome → chrome://extensions → 开发者模式 → 加载已解压 → 选择 ${EXT_DIR}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error('\n测试脚本异常:', e);
  process.exit(1);
});
