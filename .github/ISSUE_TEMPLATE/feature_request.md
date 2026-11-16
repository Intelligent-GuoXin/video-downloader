name: 功能建议
description: 新站点 / 新能力 / 体验改进
labels: [enhancement]
body:
  - type: textarea
    id: scenario
    attributes:
      label: 使用场景
      description: 你在什么页面上、想达成什么。方案可以后议，场景必须有
      placeholder: 在 XX 站的合集页里想逐条批量下载
    validations:
      required: true

  - type: textarea
    id: idea
    attributes:
      label: 你的想法
    validations:
      required: false

  - type: checkboxes
    id: checked
    attributes:
      label: 已确认
      options:
        - label: 我看过 README 的「能下什么 / 不能下什么」，这不是已知不支持的场景（DRM / YouTube 签名 / 直播）
          required: true
