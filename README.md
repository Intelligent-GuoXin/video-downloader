# 视频嗅探下载器

Chrome 扩展（Manifest V3）。打开任意页面自动识别其中的视频，在 popup 里列出来并提供下载。
支持直链文件与 HLS 分片流，可用 ffmpeg.wasm 在浏览器里转封装成 MP4。

**零构建**：原生 JS + ESM，改完代码在 `chrome://extensions` 点刷新即可，没有 npm install、没有打包步骤。

---

## 能下什么 / 不能下什么

| | 类型 | 支持情况 |
|---|---|---|
| ✅ | 直链文件（`.mp4` / `.webm` / `.mov` / `.mkv` …） | 直接调浏览器下载，自动带 Cookie / UA / Referer |
| ✅ | HLS（`.m3u8`） | 支持 master 清晰度选择、独立音轨、AES-128 解密、分片并发下载 |
| ✅ | HLS 输出格式 | `MP4 合流`（ffmpeg.wasm 转封装）或 `TS 直出`（纯拼接，秒级） |
| ❌ | DASH（`.mpd`） | 已识别但未实现下载（界面显示「暂不支持」） |
| ❌ | **DRM 加密内容**（Netflix / Disney+ / Prime Video / HBO / Apple TV+） | **设计上不做**。解密发生在浏览器内置 CDM 黑盒里，扩展没有任何 API 能碰；绕过 DRM 也违反法律与商店政策。检测到 EME 时界面会明确提示 |
| ❌ | 直播流 | 未出现 `EXT-X-ENDLIST` 的播放列表会明确报错 |

> 只应用于下载你有权保存的内容。不绕过登录、付费墙或任何加密保护。

### 常见站点会怎样

| 站点类型 | 代表 | 结果 | 卡在哪 |
|---|---|---|---|
| 标准 mp4 直链 | 教程站、企业官网、各类 CMS | ✅ 直接下 | — |
| 标准 HLS | 多数国内视频站、教育平台、直播回放、自建播放器 | ✅ 可用 | — |
| **YouTube** | youtube.com | ❌ **拿不到可用文件** | 三重障碍，见下 |
| Netflix / Disney+ / Prime Video / HBO | — | ❌ | DRM（解密在 CDM 黑盒里） |
| B 站 / 腾讯视频 / 爱奇艺 | — | ⚠️ 视具体页面 | 多为 DASH + 签名，同上 |

**YouTube 为什么不行** —— 三个互相独立的原因，缺一个都不通：

1. **流形态是 DASH，音视频分离**。播放器请求的是两条独立流（纯视频 + 纯音频）。本插件只实现了 HLS 合流，没有 DASH → 就算拿到 URL，也只能落下一个没声音的画面。
2. **URL 带签名，且绑定 IP + 时效**。`googlevideo.com` 的地址里有 `sig`（HMAC 签名）与 `n`（限速参数）。`sig` 需要用 YouTube 那套混淆过的播放器 JS 才能解出来，解不出直接 **403**；`n` 不解会被限速到几百 KB/s。签名还绑定请求方 IP、约几小时过期。
3. **2025 年后反爬已升级为复合栈**。签名之外还有 PoToken（播放令牌）、BotGuard 质询、播放器 JS 的**结构级**轮换（不是改函数名，是改结构），以及服务端静默限流。

结论：这不是"再多写点代码就能补上"的差距，而是**需要持续跟 YouTube 对抗**。yt-dlp 有专职社区维护，仍然每年被打断几十次。对自用插件来说投入产出比极低。

**如果确实需要 YouTube**：正解是装 `yt-dlp`，让专业工具干专业事。插件这边可以走 native messaging 把地址转给本机 yt-dlp，插件只当 UI —— 这属于本版有意未做的项（见 `RESEARCH.md` 的 P2），需要可以加。

---

## 安装

1. Chrome 打开 `chrome://extensions`
2. 打开右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本文件夹（含 `manifest.json` 的这一层）
4. 建议把工具栏上的图标钉住

要求 Chrome 116+（用到 `chrome.offscreen` 与 `world: "MAIN"` 内容脚本）。

---

## 使用

1. 打开有视频的页面，**点一下播放**（多数播放器要开始播放才会请求分片）
2. 点扩展图标，popup 会列出嗅探到的资源
3. 直链：直接点「下载」
4. HLS：先选清晰度与输出格式，再点「下载」
5. 进度条会实时显示；完成后文件落在 `下载/视频嗅探/<站点>/` 下

按钮含义：

- **重新嗅探** —— 手动触发一次 DOM 扫描
- **MP4 合流** —— 走 ffmpeg.wasm，输出标准 MP4，速度慢（要加载 32MB wasm）
- **TS 直出（快）** —— 只把分片拼起来，秒级完成；有独立音轨时会按段交错保证声画同步。VLC / PotPlayer 可直接播

`popup.html#tab=<标签页ID>` 可以当普通页面打开，用于调试指定标签页。

---

## 文件说明

| 路径 | 作用 |
|---|---|
| `manifest.json` | 清单。注意 `content_security_policy` 里的 `'wasm-unsafe-eval'`，否则 ffmpeg.wasm 起不来 |
| `background.js` | Service Worker：嗅探归并 + 下载编排 + 消息路由 |
| `content/hook.js` | **MAIN world** 插桩：包 `fetch` / `XHR` / `MediaSource` / `requestMediaKeySystemAccess` |
| `content/bridge.js` | ISOLATED world：DOM 扫描 + 桥接页面消息 + 上报后台 |
| `offscreen.html` / `offscreen.js` | 跑重活的地方：分片下载、AES-128 解密、ffmpeg.wasm 转封装 |
| `lib/media.js` | 媒体类型识别、格式化工具 |
| `lib/m3u8.js` | 零依赖 m3u8 解析器（master / media / KEY / MAP / BYTERANGE） |
| `lib/store.js` | 基于 `chrome.storage.session` 的状态层 |
| `popup.html` / `popup.css` / `popup.js` | 界面 |
| `vendor/ffmpeg/` | ffmpeg.wasm（`@ffmpeg/ffmpeg` UMD + `@ffmpeg/core` 单线程版，约 32MB） |
| `devtest/` | 自动化端到端测试（见下） |
| `RESEARCH.md` | 立项时的技术方案可行性调研 |

---

## 关键设计决策（都是 MV3 逼出来的）

- **三路并行嗅探**。DOM 扫描看得到 `<video>` 但看不出 `blob:`；`webRequest` 看得到真实网络 URL 但看不到响应体；`blob:` 播放器的真实分片只存在于页面 JS 上下文里，只能靠 MAIN world 插桩。三者按 URL 归并去重。
- **MAIN world 注入用 `world: "MAIN"`**，不能用 `<script>` 标签（会被页面 CSP 拦掉）。
- **`webRequest` 只用来嗅探**。MV3 里它只能观测、不能阻断（阻断仅对企业策略安装的扩展开放），所以这里不承担任何改写职责。
- **所有状态写 `chrome.storage.session`**。SW 会被随时回收，放内存变量必丢。
- **长任务全在 offscreen document**。SW 没有 DOM、30 秒空闲即死，跑不了 ffmpeg。
- **同一 tab 的状态写入串行化**（`withTabLock`）。webRequest / 内容脚本 / 播放列表探测会并发触发「读-改-写」，不加锁实测会丢数据。
- **写锁 + 消息端口**：耗时超过 SW 存活时间的操作不要同步等回执，改成「立刻受理 + 结果另行回传」。
- **`Referer` 注入用 `declarativeNetRequest` 会话规则**，只在下载任务期间挂上，结束即摘掉。部分 CDN 缺 `Referer` 直接 403。

---

## 已知限制

- **单文件体积**：MP4 转封装走内存 + MEMFS，超过约 900MB 会主动报错并提示改用 TS 直出。ffmpeg.wasm 单线程版在 300–600MB 以内比较稳。
- **`SameSite` Cookie**：offscreen 的请求是跨站发起的，`SameSite=Lax/Strict` 的 Cookie 不会带上。签名 URL（token 在 query 里）不受影响；纯靠 Cookie 鉴权的分片可能 403。
- **加密格式**：只支持 `AES-128`（key 在 m3u8 里）。`SAMPLE-AES` 属于 DRM 范畴，不支持。
- **`EXT-X-BYTERANGE`** 支持 Range 请求；服务端不支持 Range 时会失败。
- **首次 MP4 合流较慢**：要加载 32MB wasm。
- **C 档站点**：YouTube 有 signature 混淆 + PoToken、B 站有 WBI 签名，URL 抓下来直接请求会 403。本插件是「实时捕获」而非事后构造，能缓解但仍拿不到可用文件 —— 具体原因见上文「常见站点会怎样」。

---

## 开发与自动化测试

`devtest/` 里是一套真实 Chrome 端到端测试：起本地测试站点 → 用 CDP 装载扩展 → 打开测试页 → 从 popup 界面点下载 → 校验产物。

```bash
node devtest/run.mjs
```

覆盖 18 项断言：SW 启动无异常、MAIN world 插桩注入、三路检测各自命中、
master 清晰度解析、HLS 全链路（含 AES-128 解密 + 独立音轨合入）、ffmpeg.wasm 引擎可用性。

依赖 `puppeteer-core`（不下载 Chromium，直接用本机已装的 Chrome）。在 `devtest/` 里装即可：

```bash
cd devtest && npm i -D puppeteer-core
node run.mjs
```

如果它装在别处，用环境变量指定（`VD_NODE_MODULES` 可指向 `node_modules` 目录本身或其父目录）：

```bash
VD_NODE_MODULES=/path/to/node_modules node devtest/run.mjs
VD_CHROME="/path/to/chrome.exe" node devtest/run.mjs
```

### 踩过的坑（改测试时务必注意）

1. **Chrome 137+ 已禁止 `--load-extension` 命令行装载扩展**。必须改用 CDP 的 `Extensions.loadUnpacked`，
   并且启动参数要带 `--enable-unsafe-extension-debugging` + `pipe: true`。
2. **puppeteer 默认会注入 `--disable-extensions`**，必须用 `ignoreDefaultArgs: ['--disable-extensions']` 摘掉，
   否则扩展装了但完全不工作。
3. **必须清空 user-data-dir**（脚本里已经做了）。不清的话 Chrome 会复用上次装进去的扩展代码，
   导致「源码改了但测的是旧版本」，现象很迷惑：老消息类型能回、新加的不行。
4. **Service Worker 给自己发消息收不到回执** (`chrome.runtime.sendMessage` 不会派发给发送者自己)，
   测试要从 popup 页面发。
5. **CDP 的 `Browser.setDownloadBehavior` 会把落盘文件名改成 GUID**，所以断言要看产物大小，
   文件名断言用 job 记录里的 `filename`。

---

## 常见问题

- **列表是空的**：先点一下播放。部分站点用 Service Worker 代理媒体请求，`webRequest` 可能看不到，
  这类站点目前需要手填 URL（后续可接 `chrome.debugger` 深度模式）。
- **HLS 下出来没有声音**：说明该 master 用 `EXT-X-MEDIA` 分离了音轨。正常情况下插件会自动带上音频轨道；
  如果音频是加密的 `SAMPLE-AES`，会明确报错。
- **下载到一半失败**：留意 popup 里的错误文案，会区分「请求失败 4xx」「分片解密失败」「转封装失败」。
- **`视频嗅探` 目录下文件名很长**：命名规则是 `<页面标题>-<id>`，可在 `background.js` 的
  `buildFilename` / `offscreen.js` 的 `buildFilename` 里调整。

---

## 许可

本项目自有代码采用 **MIT** 许可证，见 [`LICENSE`](LICENSE)。

`vendor/ffmpeg/` 为第三方预构建产物，**不适用 MIT**：其中
`@ffmpeg/ffmpeg`（MIT）与 `@ffmpeg/core`（**GPL-2.0-or-later**）来自
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) 项目，版权归原作者所有。
再分发前请阅读 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
