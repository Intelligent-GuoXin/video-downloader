# 网页视频识别与下载插件 —— 技术方案可行性调研

> 目标：Chrome 扩展（Manifest V3），打开任意页面时自动识别其中的视频，并提供下载能力。
> 调研日期：2026-09-17

---

## 一、结论速览

**整体可行，但必须按"视频交付方式"分层设计**——不同技术路线的难度差了一个数量级。

| 档位 | 视频类型 | 典型场景 | 可行性 | 预估工作量 |
|---|---|---|---|---|
| **A** | 直链文件（`.mp4` / `.webm` / `.mov`） | 新闻站、博客、企业站、大部分社交视频 | ✅ 完全可行 | 1–3 天 |
| **B** | HLS（`.m3u8`，含 AES-128 加密） | 课程站、直播回放、部分国内站点 | ✅ 可行，需分片下载 + 拼接 | 3–7 天 |
| **C** | DASH（`.mpd`）/ MSE / `blob:` 播放器 | 大型视频平台、自研播放器 | ⚠️ 可行但要 hook 播放器内核 | 1–2 周 |
| **D** | **DRM 加密**（Widevine / PlayReady / FairPlay） | Netflix、Disney+、Prime Video、HBO、Apple TV+ | ❌ **技术上不可行，法律上禁止** | 不做 |

关键判断：

1. **A + B 覆盖了绝大多数"有下载价值"的页面**，且实现干净、风险低。建议作为主战场。
2. **C 档靠 MAIN world 注入 hook 播放器**（包 `MediaSource.prototype.appendBuffer` / `fetch` / `XMLHttpRequest`）可以拿到真实分片，属于"能做但要持续对抗站点改版"的活。
3. **D 档必须明确排除**。DRM 的解密发生在浏览器内置的 CDM 黑盒里，扩展没有任何 API 能触碰；且绕过 DRM 违反 DMCA / 著作权法及 Chrome 商店政策。任何声称"能下 Netflix"的扩展都在撒谎或违法。

---

## 二、检测层：四条技术路线对比

一个健壮的插件应该是"多路嗅探 + 结果归并"，而不是只选一条路。

| 方案 | 能看到什么 | 优点 | 缺点 |
|---|---|---|---|
| **① DOM 扫描**<br>`content_scripts` + `MutationObserver` | `<video>` / `<source>` 的 `src`、`currentSrc`、`poster`、时长、分辨率 | 零权限、最稳、能拿到元数据 | 拿不到 `blob:` 的真实地址；抓不到还没插入 DOM 的预加载资源；iframe 内需 `all_frames: true` |
| **② webRequest 观测**<br>`chrome.webRequest.onBeforeRequest` / `onHeadersReceived` | 真实网络 URL、`Content-Type`、`Content-Length`、`Range` 支持情况 | 覆盖面最广，能拿到播放器偷偷请求的分片 | **MV3 只能"观测"不能"阻断/改写"**（阻断仅对企业策略安装的扩展开放）；看不到响应体；需要 `host_permissions: <all_urls>` |
| **③ MAIN world Hook**<br>`world: "MAIN"` 注入页面上下文 | `fetch` / `XHR` 的真实 URL 与二进制；`MediaSource.addSourceBuffer` 后的分片数据 | 唯一能穿透 `blob:` 播放器的手段；能拿到响应体 | 属于"插桩"页面代码，需防御性包装避免冲突；页面 CSP 会限制 `<script>` 标签，必须用 `world: MAIN` |
| **④ `chrome.debugger`（CDP）** | 全量请求 + 响应体，能穿透 Service Worker 发起的请求 | 能力最强，DevTools 能看到的它都能看到 | 页面顶部会常驻**"XX 正在调试此浏览器"横幅**；`debugger` 权限在商店审核中高度敏感；一个 tab 只能开一个调试会话 |

**推荐组合**：`① DOM 扫描` + `② webRequest 观测` + `③ MAIN world Hook` 三路并行，结果按 URL 去重归并到同一个列表。
**④ debugger 做成"深度模式"开关**，默认关闭，只在用户明确遇到"嗅探不到"时手动启用。

---

## 三、下载与合流

### 3.1 直链视频（A 档）

优先用 `chrome.downloads.download({ url })`。原因：**它走浏览器自己的网络栈，会自动带上 Cookie / UA / Referer**，对付登录态 URL 和签名 URL 几乎零成本。
自己 `fetch` 再转 blob 反而容易踩 CORS 和鉴权坑——仅在产品需要重命名、或需要先合并再落盘时才用 `fetch`。

### 3.2 HLS（B 档）

标准流程：

```
解析 m3u8 → 若是 master playlist 则选码率 → 取 media playlist
→ 并发下载分片（存 IndexedDB，不驻留内存）
→ 合流 → 触发保存
```

三个必须处理的细节：

- **AES-128 加密的 HLS 不算 DRM**：密钥 URI 就写在 m3u8 里，直接取回来解密即可，业界通行做法。
- **合流有两种档位**：
  - 纯 TS 分片 → 直接二进制拼接成 `.ts` 文件。**零依赖、秒级完成**，VLC / PotPlayer 能直接播，但不是 MP4。
  - 要输出 MP4 / MKV → 需要 remux（`-c copy`，不做转码，速度可以接受）。
- **`EXT-X-BYTERANGE` / 加密的 fMP4** 是常见坑点，MVP 阶段可以先不支持并明确报错。

### 3.3 DASH（C 档）

比 HLS 复杂：要解析 MPD，处理 `SegmentTemplate` 的 `$Number$` / `$Time$` 占位符，还要单独拿 init segment。合流同样依赖 ffmpeg。

### 3.4 ffmpeg.wasm 在 MV3 里的坑（重要）

| 问题 | 说明 | 对策 |
|---|---|---|
| SW 里跑不了 | Service Worker 无 DOM，且 30s 空闲即被回收，长任务必死 | **放到 offscreen document 里跑**（这是社区的通行做法） |
| SharedArrayBuffer | ffmpeg.wasm 多线程版依赖 `SharedArrayBuffer`，需要 COOP/COEP 跨源隔离 | 扩展页可通过 manifest 的 `cross_origin_embedder_policy` / `cross_origin_opener_policy` 开启，但版本兼容要实测；**更稳的做法是用单线程 core**，慢一些但不会崩 |
| 包体积 | ffmpeg.wasm 全量约 25–30 MB | 商店审核变慢；也可只打包 remux 需要的精简构建 |
| 内存 | 长视频一次性读入必爆内存 | 分片先落 IndexedDB，流式喂给 ffmpeg |
| 替代方案 | 走 **Native Messaging 调本机 ffmpeg** | 速度快 10 倍以上、无体积负担，代价是每个用户要装本机程序（你在 `oauth-code-fill` 里已经跑通过这套链路，插件 ID 绑定路径的坑也知道怎么绕） |

---

## 四、Manifest V3 的硬约束清单

| 约束 | 影响 | 应对 |
|---|---|---|
| Service Worker 会被随时回收 | 检测到的视频列表**不能只放内存变量** | 状态写 `chrome.storage.session` / `local`，按 tabId 维护 |
| webRequest 无阻断能力 | 无法改写请求头来绕过 Referer 校验 | 用 `declarativeNetRequest` 的 **session rules** 动态注入请求头 |
| 禁止远程加载代码 | ffmpeg.wasm 等必须打包进扩展包 | 接受体积，或改走本机程序 |
| 页面 CSP 拦截 `<script>` 注入 | 老式注入 hook 的方式会失败 | 用 `content_scripts` 的 `world: "MAIN"`，或 `chrome.scripting.executeScript({ world: 'MAIN' })` |
| 下载路径受限 | `chrome.downloads.download` 的 `filename` 只能落在默认下载目录的相对路径 | 用子目录名组织，如 `视频嗅探/站点名/标题.mp4` |
| 扩展 ID 由文件夹绝对路径决定 | 一旦走 Native Messaging，**挪动文件夹就要重装宿主** | 沿用你现有的 `install_host.bat` 套路 |

---

## 五、合规红线（必须写进设计）

1. **不碰 DRM**：不实现任何 CDM 绕过、不注入解密逻辑。检测到 EME / license 请求时，向用户**明确提示"该内容受 DRM 保护，无法下载"**，不要静默失败。
2. **不绕过付费墙 / 登录**：只下载用户当前会话本身就能正常播放的内容。签名 URL 可以抓，但那只是时效性 token，不是加密。
3. **不宣称"下载任意网站视频"**：这个文案在 Chrome 商店属于高危表述，容易被下架。建议定位为"个人内容存档工具"，并内置免责声明。
4. **可选内置域名屏蔽表**：便于以后应对站点 opt-out 请求（`puemos/hls-downloader` 就是这么做的）。

---

## 六、分期路线图

| 阶段 | 交付内容 | 依赖 |
|---|---|---|
| **P0 · MVP** | DOM 扫描直链视频 + popup 列表 + 一键下载；tab 切换自动刷新 | 无第三方依赖，纯原生 JS |
| **P1** | webRequest 嗅探 `.m3u8` / `.mp4`；HLS 分片下载 + TS 直接拼接；清晰度选择 | m3u8 解析器 |
| **P2** | ffmpeg.wasm remux 输出 MP4/MKV；DASH 支持；直播流边下边存 | ffmpeg.wasm / offscreen document |
| **P3** | MAIN world Hook 覆盖 `blob:` 播放器；native messaging 接本机 ffmpeg 加速 | 插桩 + 本机程序 |

---

## 七、可参考的开源实现（建议直接读源码）

| 项目 | 值得借鉴的点 |
|---|---|
| `puemos/hls-downloader`（MIT，MV3） | offscreen 里跑 ffmpeg.wasm、码率/音轨选择、屏蔽表机制 |
| `jvillegasd/media-bridge` | 完整架构：SW 编排 + content script + offscreen + IndexedDB 分片 + AES-128 解密 + DNR 注入请求头 + 直播录制 |
| `andy-portmen/open-in-vlc` | webRequest 嗅探 + Content-Type 判定 + 逐 tab 存储，检测层写得很干净 |
| `yt-dlp`（本机） | 各站点站点的提取逻辑（signature / token），可作为"服务端方案"的对照 |

---

## 八、已知风险清单

- **站点反爬（本版最大边界）**：YouTube 有 signature 混淆（`sig` / `n`）、B 站有 WBI 签名，URL 抓下来直接请求会 403 → 必须**在播放时实时捕获**，不能事后构造。
  - **2025 年后 YouTube 的反爬已升级为复合栈**：签名之外加了 PoToken（播放令牌）、BotGuard 质询、播放器 JS 的**结构级**轮换（不是改函数名而是改结构），以及服务端静默限流；`googlevideo.com` 地址还绑定请求方 IP 并约几小时过期。
  - 叠加 YouTube 的流形态是 **DASH（音视频分离）**，而本版只实现 HLS 合流 → **YouTube 实际上拿不到可用文件**（详见 `README.md` 的「常见站点会怎样」）。
  - **设计原则**：不与平台反爬机制对抗。这类工作应由 yt-dlp 这类有专职维护的工具承担；插件若需要，正确姿势是 native messaging 转发给本机 yt-dlp，而不是自己实现签名算法。
- **Service Worker 代理媒体请求**：部分站点用 SW 拦截媒体请求，`webRequest` 可能看不到 → 需要 debugger 或页面 Hook 兜底。
- **iframe 播放器**：大量站点把播放器塞在 iframe 里 → `all_frames: true` 必开。
- **大文件**：必须分片落 IndexedDB，禁止一次性 `arrayBuffer()`。
- **商店审核**：`debugger` / `<all_urls>` / 大体积 wasm 都会拖慢审核。若只自用（加载已解压），这些都不是问题。
- **长期维护成本**：C 档 hook 会随站点改版失效，属于持续投入。

---

## 九、待确认事项

见下方"需要你拍板的 4 个问题"，确认后即可开始 P0 脚手架。

---

## 十、实施与验证结果（2026-09-17 更新）

已按「通用型 + 内置 ffmpeg.wasm + 零构建原生 JS + 加载已解压自用」落地，见 `README.md`。

**已实现并自动化验证（`node devtest/run.mjs`，18/18 通过）：**

| 项 | 结果 |
|---|---|
| MV3 Service Worker 启动 | ✅ 无未捕获异常 |
| DOM 扫描 / webRequest 观测 / MAIN world 插桩 | ✅ 三路各自命中预期资源 |
| HLS master 解析 + 清晰度列表 | ✅ 2 档 |
| HLS 全链路：分片并发下载 → AES-128 解密 → 独立音轨按段交错 → 拼接 → 落盘 | ✅ 6 个分片全部合入，字节数精确匹配 |
| popup 界面渲染 + 点击下载 | ✅ 走真实 UI |
| **ffmpeg.wasm 在扩展内可用**（lavfi 现场生成真实 H.264+AAC TS → 转封装 MP4） | ✅ TS 22184B → MP4 17507B |

**实施中修正的设计假设：**

1. **`webRequest` 观测层需要快速预筛**：`onBeforeRequest` 触发量极大，先用正则粗筛再走异步落盘。
2. **MAIN world 上报必须转绝对路径**：页面里拿到的是 `/media/a.mp4` 这种相对路径，
   不转换会被后台的 http(s) 校验直接丢掉。
3. **同一 tab 状态写入必须加锁**：并发「读-改-写」实测会丢掉 HLS 清晰度列表。
4. **耗时超过 SW 存活时间的操作不能同步等消息回执**：会拿到
   `The message port closed before a response was received`。改成「立刻受理 + 结果另行回传」。
5. **分离音轨不能丢**：master 用 `EXT-X-MEDIA` 分离音频时，TS 直出必须按段交错，
   否则声音全跑到片尾（或直接静音）。

**仍未实现（本版有意不做）：** DASH 下载、直播录制、`chrome.debugger` 深度模式、native messaging 本机 ffmpeg。

