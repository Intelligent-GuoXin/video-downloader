# 第三方组件声明

本项目**自有代码**采用 MIT 许可证，见 [`LICENSE`](LICENSE)。

`vendor/` 目录下为第三方预构建产物，**不适用 MIT 许可证**，其版权与许可证归原作者所有。

---

## vendor/ffmpeg/

来源：[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)

| 文件 | 上游 npm 包 | 许可证 |
|---|---|---|
| `ffmpeg.js`、`814.ffmpeg.js` | `@ffmpeg/ffmpeg` | MIT |
| `ffmpeg-core.js`、`ffmpeg-core.wasm` | `@ffmpeg/core` | **GPL-2.0-or-later** |

说明：

- 被编译进 `ffmpeg-core.wasm` 的 FFmpeg 本体为 LGPL/GPL 双轨授权；
  但 `@ffmpeg/core` 的**预构建产物**按 **GPL-2.0-or-later** 分发（其 npm 包的 `license` 字段即为该值）。
- 上游源码：<https://github.com/ffmpegwasm/ffmpeg.wasm>
- GPL-2.0 许可证全文：<https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>
- 本仓库中的这些文件**未做任何修改**，以原样保留。

### 对再分发者的提示

GPL-2.0 是强著佐权（copyleft）许可证。将它与你自己的代码**打包成一个整体**分发时，
该分发物需满足 GPL-2.0 的要求（提供对应源码、保留许可证声明、不附加额外限制）；
若仅作为**并列的独立组件**随同一介质分发，通常被视为聚合分发（mere aggregation）。

把 `ffmpeg-core.wasm` 直接放进扩展目录属于哪一类，法律上有争议。
如果你希望整个项目以纯 MIT 对外分发，做法是**不随仓库分发该二进制**，
改为在文档里指引用户自行下载放入 `vendor/ffmpeg/`。

---

## 开发依赖

`devtest/package.json` 里的 `puppeteer-core` 为开发期依赖（Apache-2.0），
不随扩展本体分发。
