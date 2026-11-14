# v0.1.1

- 修复 Chat Completions 的原始 reasoning_effort 被宿主预算转换覆盖；保留 Grok max 映射与 GPT none 原生参数。
- 修复 Responses 缓存写入 Token 遗漏；部分用量字段缺失时继续估算，显式零值保留。
- 拒绝 IDC 凭据导入 Social 渠道，避免发送到错误的认证端点。
- 将 AWS 错误事件、空响应流和异常用量明确报告为错误；保留合法的隐藏推理空答案。
- 按具体工具调用配对历史结果，避免重复 ID 留下未回答调用。
- 新增 New API rc.50 / rc.51 完整请求与响应链路验证，覆盖 AWS 帧、三种协议、工具和用量。

验证使用模拟上游和实际宿主运行时，未用真实 Kiro 账号测试。Profile ARN 等边界见 README。

Fixes explicit Chat reasoning effort, native GPT none, cache-write and partial token accounting, mismatched IDC imports, silent AWS errors/empty streams, and reused tool IDs in history. Adds complete host conversion tests for rc.50 and rc.51. Synthetic upstream validation only; live-account and host limitations remain documented.
