/**
 * 端到端验证脚本：真实 Chrome + 加载已解压扩展 + 本地测试站点。
 *
 * 覆盖点：
 *  1. MV3 Service Worker 能否正常注册启动（不报错）
 *  2. 三路检测（DOM 扫描 / 网络嗅探 / MAIN world 插桩）是否都能拿到资源
 *  3. HLS master 解析、清晰度选择
 *  4. 从 popup 界面点「下载」→ 分片下载 → AES-128 解密 → 拼接 → 落盘 整条链路
 *
 * 用法：node devtest/run.mjs
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..');

/**
 * puppeteer-core 装在哪儿都行，这里按顺序探测。
 * ESM 的 import 不会向上查找 node_modules，所以必须用 createRequire 显式解析。
 * 优先读环境变量 VD_NODE_MODULES（可指向 node_modules 目录本身，也可指向它的父目录）。
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
const CHROME = process.env.VD_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
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
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check']
  });

  const swErrors = [];
  const swLogs = [];
  let liveCdp = null;
  let liveAttached = false;
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

    // ---- 5. ffmpeg.wasm 引擎自检 ----
    // 从 popup 页面发送（Service Worker 给自己发消息收不到回执），结果从 storage 轮询
    log('\n[5] ffmpeg.wasm 引擎自检（现场生成真实 TS，再走生产用的转封装代码）');

    // MV3 的 SW 会被回收。冷启动时第一条消息可能拿不到回执
    // （"message port closed"），先预热再发，并对失败做重试。
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

    let ack = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const warm = await sendFromPopup({ type: 'GET_STATE', tabId: null });
      const swTargets = browser.targets().filter((t) => t.type() === 'service_worker').map((t) => t.url());
      log(
        `      预热(GET_STATE) = ${warm && warm.ok ? 'ok' : JSON.stringify(warm)}` +
          `  SW targets=${swTargets.length}`
      );

      // 把 console 监听挂到「当前」SW 实例上（SW 可能已经重启过，旧会话收不到日志）
      if (!liveAttached) {
        const liveTarget = await browser.waitForTarget(
          (t) => t.type() === 'service_worker' && t.url().includes(extId),
          { timeout: 10000 }
        );
        liveCdp = await liveTarget.createCDPSession();
        await liveCdp.send('Runtime.enable');
        liveCdp.on('Runtime.consoleAPICalled', (e) =>
          swLogs.push(`[live] ${e.type} ${(e.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`)
        );
        liveCdp.on('Runtime.exceptionThrown', (e) =>
          swErrors.push(
            `[live] ${e.exceptionDetails?.exception?.description || e.exceptionDetails?.text || 'unknown'}`
          )
        );
        liveAttached = true;
      }

      ack = await sendFromPopup({ type: 'ENGINE_SELFTEST' });
      if (ack && ack.started) break;
      log(`      第 ${attempt} 次未受理：${ack && ack.error}`);
      await sleep(1500);
    }
    check(Boolean(ack && ack.started), `自检任务已受理（${JSON.stringify(ack)}）`);

    const readDiag = async () => {
      const t = await browser.waitForTarget(
        (x) => x.type() === 'service_worker' && x.url().includes(extId),
        { timeout: 20000 }
      );
      const w = await t.worker();
      return w.evaluate(async () => (await chrome.storage.session.get('diag:engine'))['diag:engine'] || null);
    };

    let diag = null;
    for (let i = 0; i < 120; i += 1) {
      await sleep(1000);
      diag = await readDiag();
      if (diag && !diag.running) break;
    }

    const st = (diag && diag.result) || {};
    log(
      `      rc(-version)=${st.rcVersion}  rc(gen)=${st.rcGen}  genSize=${st.genSize}` +
        `  rc(mux)=${st.rcMux}  mp4Size=${st.mp4Size}`
    );
    if (st.muxError) log(`      mux 错误: ${st.muxError}`);
    if (diag && diag.error) log(`      错误: ${diag.error}`);
    if (st.rcGen !== 0 || st.rcMux !== 0) {
      if (st.log) log(`      ffmpeg 日志尾部:\n${st.log}`);
    }
    check(
      st.ok === true,
      `ffmpeg.wasm 可在扩展内加载并完成真实转封装（TS ${st.genSize} → MP4 ${st.mp4Size} bytes）`
    );

    // ---- 6. 汇总 ----
    log('\n[6] SW 日志');
    swLogs.slice(-25).forEach((l) => log('    ' + l));
    log('\n[6] Service Worker 未捕获异常');
    if (swErrors.length) swErrors.slice(0, 5).forEach((e) => log('    ⚠️ ' + String(e).split('\n')[0]));
    else log('    （无）');

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
