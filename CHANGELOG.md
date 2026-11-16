# Changelog

本项目的所有显著变更都记录在这个文件里。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.0] — 2026-11-17

「下错视频」专项修复 + 面向开源的结构重构。**破坏性变更：移除 ffmpeg.wasm。**

### 修复

- **「总会下错视频」**（信息流页面的核心痛点，三处叠加修复）：
  - 新增「正在播放」识别：MAIN world 插桩 `SourceBuffer.appendBuffer`，把「刚完成的媒体请求被喂进哪个
    MediaSource」上报；桥接脚本核对挂着该 blob 地址的 `<video>` 元素确实在播。信息流页面预加载的
    「下一条」视频过不了这关。列表里正在播放的条目带 ▶ 徽标并置顶（此前按「最近请求」排序，
    短视频开场就缓冲完、预加载视频反而一直刷 lastSeen，排最前的经常是下一条）。
  - **音轨配对时长硬校验**：显式指定音轨合并前，双方时长都已知且差 ≤ 0.8s/2% 才放行，
    否则判失败并明确提示「这多半是同页另一个视频的音轨」。此前会安静地合成出
    「画面 2 秒、声音 4 秒」的错位文件。
  - **DASH 自动配对收紧**：候选音轨与视频的时长必须双方都已知且匹配；时长未知的候选一律跳过
    （此前「视频时长未知」时放行任意纯音轨候选，是串轨的直接入口）。候选排序改为「正在播放」优先。
  - popup 配对 UI 同步收紧：只有时长精确匹配才自动配「下载（含音频）」；时长未知只进下拉由用户
    核对；视频自身时长未知时不提供配对。

### 变更

- **移除 ffmpeg.wasm**（`vendor/ffmpeg/`，约 32MB）：
  - 主力路径（TS→MP4 重封装、音视频合并、fMP4 转换）早已全部纯 JS，ffmpeg 只剩「小文件非常规封装」
    的兜底场景，且大文件必然 OOM；
  - `@ffmpeg/core` 以 GPL-2.0-or-later 分发，对 MIT 项目是持续的许可证混染风险；
  - 重封装失败现在统一降级成 TS 直出并说明原因（此前小文件走 ffmpeg 兜底）。
  - manifest 移除 `wasm-unsafe-eval` CSP 与 `web_accessible_resources`；删除引擎自检
    （`ENGINE_SELFTEST`）与对应测试断言；仓库不再含任何二进制文件。
- **代码结构重构**（对外行为不变）：
  - `offscreen.js` 从 1386 行拆为 `offscreen.js`（消息路由，~150 行）+ `offscreen/core.js`
    （上下文/上报）+ `offscreen/registry.js`（任务登记）+ `jobs/hls.js` + `jobs/direct.js`；
  - 网络层抽成 `lib/transport.js`（域名并发限流、可取消 fetch、分片重试），
    输出落盘抽成 `lib/outputsink.js`；
  - background 抽出 `lib/referer.js`（DNR 规则管理）、`lib/offscreendoc.js`；
  - 两处重复的 `buildFilename` 统一为 `lib/naming.js`。
- popup 打开期间轻量轮询（2s），「正在播放」标记与排序跟着页面实际播放走。
- 探测到的轨道信息现在会回填条目时长（配对可用证据 +1）。

### 测试

- 新增断言：正在播放标记（模拟 MSE 喂流关系）、popup「正在播放」徽标、
  DASH 错误时长候选必须被跳过（产物时长必须等于视频时长）、显式配对时长不符必须失败且不落盘。
- 测试用合成 MP4 补上真实 `mvhd` 时长（与真实文件一致，配对才有依据）。
- 移除 ffmpeg 引擎自检断言。当前 47 项断言。

## [0.4.5] — 2026-11-16

### 修复

- **DASH 分离流自动配对**：抖音搜索页的视频流 / 音频流是两条独立地址，64KB 探测读不到 moov、
  列表里无标签无配对按钮。现在点视频那条：抓取 → 转标准 MP4 → 解析轨道 → 自动抓同页最近
  90 秒的候选 → 认出「纯音轨且时长匹配（≤ 0.8s）」→ 合并交付；全落空则交付画面并注明。
- **fMP4 分片流下载**：此前分片流条目按钮被禁用（产物打不开）。现在下载后把样本表从 `moof`
  搬进 `stbl` 转成标准 MP4 再交付；只覆盖一半以下时长时明确报错。
- **列表排序错位**：按 `lastSeen`（最后一次被请求时间）倒序替代首次捕获时间，
  预加载的视频不再霸占前排。
- **下载完整性对账**：结束后与 `Content-Length` 对账，不齐就删文件报「下载中断」，
  不再把截断文件当成功交付。
- 新增 `lib/mp4remux.js`：纯 JS 无损合成（替代此路径上的 ffmpeg.wasm 回退）、
  fMP4 → 标准 MP4 转换；`lib/mp4probe.js`：轨道构成识别。
- 抖音 CDN 无后缀 URL（`mime_type=video_mp4`）识别。

## [0.4.1] — 2026-11-15

### 修复

- **抖音 403**：`douyinvod.com` 按 Referer 白名单判权，而 `chrome.downloads.download()`
  的请求既不带页面 Referer 也不吃扩展的 DNR 规则（实测）。改为：探测 401/403 时挂临时
  Referer 规则、在 offscreen 里 `fetch` 抓取落盘后以 blob 交付；浏览器下载器自己撞 403
  也自动回退到该路径。
- Referer 规则按任务隔离（早期是写死 ID 9001 的全局规则，多标签页并发互相覆盖导致 403）。

## [0.4.0] — 2026-11-14

### 新增

- **断点续传**：分片边下边写 OPFS（`lib/segstore.js`），失败 / 取消 / 重启后从断点继续；
  播放列表变化才判定换内容清掉重下。
- **流式重封装 TS → MP4**（`lib/tsdemux.js` + `lib/mp4mux.js`）：不重编码、mdat 边生成边
  落盘，内存与文件大小无关，不再有 900MB 上限；替代 ffmpeg.wasm 主力路径。
- 多标签页并发下载：按任务并行（最多 3 个）+ 域名级并发限流 + 分片失败重试（指数退避）。

## [0.3.0] — 2026-11-12

### 新增

- HLS master 清晰度选择、`EXT-X-MEDIA` 独立音轨合入（按段交错保证声画同步）、
  AES-128 解密、`EXT-X-BYTERANGE`。
- 三路嗅探：DOM 扫描 + webRequest + MAIN world 插桩（fetch / XHR / MSE / EME 探测）。
- 端到端测试框架（puppeteer + CDP `Extensions.loadUnpacked`）。

## [0.1.0] — 2026-11-10

### 初始版本

- MV3 骨架：SW + offscreen + content scripts（双 world）+ popup。
- 直链下载、HLS 媒体播放列表下载、TS 直出。
