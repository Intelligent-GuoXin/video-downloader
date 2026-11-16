name: 问题反馈
description: 下载失败、下错内容、界面异常
labels: [bug]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: 发生了什么
      description: 预期行为 vs 实际行为
      placeholder: 点了「下载（含音频）」，弹窗报「音轨时长对不上……」
    validations:
      required: true

  - type: input
    id: site
    attributes:
      label: 站点（脱敏）
      description: 域名 + 大致路径即可，不要贴带登录态 / token 的完整 URL
      placeholder: www.douyin.com 推荐流
    validations:
      required: true

  - type: dropdown
    id: kind
    attributes:
      label: 资源类型
      options:
        - 直链 mp4
        - HLS（m3u8）
        - 音视频分离（列表里分「仅视频」「仅音频」两条）
        - DASH 分离流（无标签、下载时自动找音轨）
        - 分片流（条目标着「分片流」）
        - 不确定
    validations:
      required: true

  - type: textarea
    id: popup
    attributes:
      label: popup 列表截图或描述
      description: 重点带上条目上的徽标（▶ 正在播放 / 仅视频 / 时长 / 分片数）
    validations:
      required: false

  - type: textarea
    id: logs
    attributes:
      label: 报错文案 / 控制台输出
      placeholder: 失败面板上的原文
    validations:
      required: false

  - type: input
    id: version
    attributes:
      label: 扩展版本
      placeholder: 0.5.0
    validations:
      required: true
