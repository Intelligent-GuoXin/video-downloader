# 贡献指南

感谢你愿意给这个项目提代码 / 提问题。这是一个「零构建、零依赖」的项目，
贡献门槛刻意保持得很低：**改完代码不需要任何编译步骤**。

## 项目约定（先读这个）

1. **零构建**：原生 JS + ESM，不引入打包器 / TypeScript / 框架。扩展直接从源码目录加载，
   `devtest/` 的端到端测试也直接测源码。引入构建链路 = 破坏本项目最大的卖点。
2. **零运行时依赖**：不引入 npm 依赖到扩展本体。解封装 / 封装 / remux 都是自研纯 JS
   （这是 0.5.0 移除 ffmpeg.wasm 的原因，不要把它加回来）。
3. **MV3 的三条铁律**（大多数 bug 都源于违反它们）：
   - Service Worker 随时会被回收 → 跨事件状态必须进 `chrome.storage.session`，不放内存变量；
   - SW 30s 空闲即死、无 DOM → 长任务一律进 offscreen document；
   - `webRequest` 只能观测不能改写 → 改请求头走 `declarativeNetRequest`（`lib/referer.js`）。
4. **写锁**：对 tab 状态的「读-改-写」必须过 `withTabLock`（background.js），
   并发写入会互相覆盖。
5. **配对必须校验时长**：任何「把音频接到视频上」的路径（UI 自动配对 / 下载时自动配对 /
   手动指定）都要有时长硬校验兜底。时长对不上 = 一定是两条不同的内容。
   这是「下错视频」类 bug 的最后一道闸。
6. **失败要说话**：宁可明确报错，也不要交付一个看起来成功实际有问题的文件
   （残片、错位音轨、打不开的封装）。
7. 注释解释「为什么」，不解释「什么」。中文注释（与现有代码保持一致）。

## 代码结构

见 README 的「代码结构」一节。依赖方向单向：
`content/*` → 消息 → `background.js` → `jobs/*` → `lib/*`。
`lib/` 里的模块除 `transport` / `outputsink`（天然有 IO）外必须无副作用。

## 开发环境

```bash
git clone <repo>
cd video-downloader
# 加载扩展：chrome://extensions → 开发者模式 → 加载已解压 → 选仓库根目录
```

改完代码在 `chrome://extensions` 点扩展卡片上的刷新即可生效。

## 跑测试（提 PR 前必须全绿）

```bash
cd devtest && npm i -D puppeteer-core
cd ..
node devtest/run.mjs
```

- 需要本机装了 Chrome（默认路径猜不到时用 `VD_CHROME` 指定）；
- 容器 / CI 里跑不动时加 `VD_CHROME_ARGS="--no-sandbox --disable-gpu"`；
- 测试是真实 Chrome 端到端：装载扩展 → 打开测试页 → 从 popup 界面点下载 → 校验产物。
  **只跑单测脚本 / 只看 console 不算验证**，产物字节级断言才算。

### 新增测试的注意事项

- Chrome 137+ 禁止 `--load-extension`，测试用 CDP `Extensions.loadUnpacked`（已在 run.mjs 里）；
- 断言落盘产物时记住 CDP 会把文件名改成 GUID，看大小 / 内容，文件名用 job 记录里的 `filename`；
- 涉及「正在播放 / MSE」的测试参考 run.mjs 的 [4c]：模拟 MediaSource 挂到 video 元素 + appendBuffer。

## 提交规范

- commit message 用中文或英文均可，格式 `类型: 摘要`（类型：feat / fix / refactor / test / docs / chore）；
- 一个 PR 做一件事；重构与功能修复不要混在一个 PR 里；
- 有用户可见行为变化的，同步更新 `README.md` 与 `CHANGELOG.md`。

## 提 Issue

- **下载失败 / 下错**：附上站点类型（不要贴需要登录态的完整 URL，脱敏后的域名 + 路径即可）、
  popup 列表截图（能看到条目上的徽标与标签）、控制台报错文案；
- **新站点支持**：先看 README 的「能下什么」和「常见站点会怎样」，确认不是已知不支持
  （DRM / YouTube 签名 / 直播）；
- **功能建议**：说明场景，不只是方案 —— 好几个设计决策都是从场景倒推出来的。
