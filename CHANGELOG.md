# v0.1.0

首个 New API 原生 Kiro 渠道插件版本，基于 kiro4cpa-plugin `1582a9c`，同步 kiro.rs v0.9.9 适用修复。

- 支持 Claude Messages、OpenAI Chat Completions / Responses 的流式和非流式转换。
- 支持 Google/GitHub 完整回调表单、Builder ID/IAM 设备登录、凭据导入、刷新及 API Key。
- 接入实时模型列表、Credit 额度、工具流完整性校验、原生推理与历史签名保护。
- 固定 New API v1.0.0-rc.50 宿主契约测试和三平台 Node 测试。

验证基于模拟上游，无真实 Kiro 账号实测。Profile ARN 按渠道配置；其他边界见 README 的已知限制。

Initial native New API Kiro provider release. Includes streaming/nonstreaming protocol conversion, OAuth/device login and credential import, token refresh, API keys, live models and Credit windows, tool integrity and reasoning safeguards. Verified using synthetic upstream responses and New API v1.0.0-rc.50; no live Kiro account validation. Profile ARN is configured per channel. See README.en.md for limitations.
