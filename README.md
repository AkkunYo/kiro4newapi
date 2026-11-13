# kiro4newapi

[English](README.en.md)

把 Kiro 账号接入 New API 的原生渠道插件。安装一个 `plugin.js`，由 New API 管理账号、刷新 Token 和转发请求，无需额外运行 CPA 或代理服务。

基于 [kiro4cpa-plugin](https://github.com/AkkunYo/kiro4cpa-plugin) 的协议实现移植，已同步 [kiro.rs v0.9.9](https://github.com/ZyphrZero/kiro.rs/releases/tag/v0.9.9) 的适用修复。首版验证宿主为 [New API v1.0.0-rc.50](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.50)，需要支持 Provider part 的插件系统；旧版仅支持任务插件的 New API 无法加载。

## 安装

1. 从 [Releases](https://github.com/AkkunYo/kiro4newapi/releases) 下载 `plugin.js`，或下载 ZIP 中的同名文件。`SHA256SUMS` 用于校验。
2. 在 New API 的插件管理页（`/task-plugins`）上传该文件并启用。插件名称 **Kiro**，标识 `akkunyo-kiro`。
3. 创建绑定此插件的 **插件渠道（类型 61）**。Base URL 默认为 `https://q.us-east-1.amazonaws.com`；欧洲区域可设为 `https://q.eu-central-1.amazonaws.com`。不要添加 `/v1`。
4. 保存渠道配置，按下表登录或添加 Key，然后获取模型列表并配置允许使用的模型、分组和计费价格。
5. 客户端仍使用你的 New API 地址和令牌。Kiro 凭据只保存在网关，不填到客户端。

请使用发布文件或根目录生成的 `plugin.js`；`src/` 中的模块不能单独上传。Kiro Credit 额度与 New API 对客户端的收费价格相互独立，本插件不设置模型价格。

## 账号配置

| 配置项           | 用途                                                           |
| ---------------- | -------------------------------------------------------------- |
| `credentialType` | `social`（Google/GitHub）、`builder-id`、`iam` 或 `api_key`    |
| `loginMode`      | `browser` 交互登录，或 `import` 导入刷新凭据                   |
| `authRegion`     | 认证区域，默认 `us-east-1`，与推理 Base URL 独立               |
| `profileArn`     | 可选的真实 Kiro Profile ARN，按渠道配置                        |
| `startUrl`       | IAM Identity Center 的 `https://<directory>.awsapps.com/start` |
| `clientVersion`  | Kiro 客户端标识，默认 `1.4.5`                                  |

**Google / GitHub：**选择 `social` + `browser`，点击登录。在表单说明中复制并打开授权链接。完成授权后，浏览器跳转到 `http://127.0.0.1:3128/oauth/callback?...` 或 `/signin/callback?...`；即使页面无法打开，也复制地址栏的**完整 URL**，粘贴回登录表单。插件校验 state，并用宿主保管的 PKCE verifier 换取 Token。不要删除回调路径、state 或 `login_option`。开始此流程前，避免其他本地程序占用 3128 端口。

**Builder ID / IAM：**选择相应类型和认证区域，点击登录，按设备码页面完成授权；IAM 还需设置 `startUrl`。轮询、Token 保存和后续刷新由宿主管理。

**导入：**选择正确的凭据类型和 `import`，点击登录并粘贴 JSON。插件会立即刷新验证凭据。Social 至少需要 `refreshToken`；Builder ID / IAM 还需要 `clientId` 和 `clientSecret`。支持现有项目的 `authMethod: "idc"`、`idcRegion` 等字段。下例仅为占位符：

```json
{
  "authMethod": "social",
  "authRegion": "us-east-1",
  "refreshToken": "YOUR_REFRESH_TOKEN"
}
```

**API Key：**选择 `api_key`，在渠道 Key 字段填写 Kiro API Key；无需点击登录。插件使用 `tokentype: API_KEY`，不附加 Profile ARN。

一个渠道内的账号应使用相同凭据类型和 Profile ARN 要求。New API 的 `convertRequest` 无法读取每个账号的凭据，而 `signRequest` 无法修改正文，因此不能自动把登录返回的每账号 ARN 放进推理请求。可在 `profileArn` 配置真实 ARN；不同 ARN 的账号拆分渠道。留空时，推理沿用 CPA 的 Social / IDC 兼容 ARN；模型与额度查询先尝试不带 ARN，必要时尝试渠道 ARN和区域回退。

## 支持范围

| 能力                    | 首版行为                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Claude Messages         | `/v1/messages`，流式与非流式                                                          |
| OpenAI Chat Completions | `/v1/chat/completions`，通过宿主转换 Claude 协议                                      |
| OpenAI Responses        | `/v1/responses`，通过宿主 Chat Completions 转换链                                     |
| 工具调用                | 历史配对、缺失工具定义补齐、长名称缩短/还原、交错片段按 ID 收集；参数完整并验证后输出 |
| 图片                    | 内联 base64 JPEG / PNG / GIF / WebP；不下载远程图片 URL                               |
| 推理                    | 原生 reasoning、旧模型 thinking 标签、Grok `max → xhigh`、显式关闭隐藏原生推理        |
| 历史推理                | 保留唯一且有效的签名/加密块；多块、无签名、占位签名、非法 base64 不转发               |
| 签名拒绝                | 明确的 `THINKING_SIGNATURE_INVALID` 只剥离历史 reasoning 并重试一次                   |
| 模型                    | 获取账号实时列表，分页有上限，保留上游提供的上下文信息；可用权限由上游决定            |
| 额度                    | 月度、有效试用和奖励的 Credit 窗口；不伪造美元余额                                    |
| Token 用量              | 优先保留上游输入、输出和缓存 Token 数；缺失时估算                                     |

## 已知限制

- Kiro 非公开接口可能变化。本版本通过模拟上游和官方宿主运行时验证，**未使用真实 Kiro 账号验证登录、推理或历史签名接受情况**。
- `max_tokens`、temperature、top_p、top_k、stop_sequences、tool_choice 和结构化输出约束没有可靠的 Kiro 对等控制，当前不会强制执行。助手末尾 prefill 会移除。Responses 的存储、后台任务、多模态扩展不由本插件实现。
- 流式工具参数会缓冲至完整；响应状态最多约 4 MiB 字符、128 个工具调用。超限或损坏的工具参数会报错。
- 只有 Claude Messages 的签名历史可以原样传入原生 reasoning union；OpenAI 转换链不保证保留签名。关闭 thinking 时不会把原生推理当作答案显示。
- rc.50 的模型/额度管理请求仅对 HTTP 401 自动刷新；Kiro 若用 HTTP 403 表示 Token 失效，插件显示认证错误，不进行区域重试。等待宿主刷新、通过正常请求触发刷新，或重新登录后再查询。正常推理请求可通过 `credentialRejected` 识别此类 403。
- 不包含 CPA 的管理网页、二进制 RPC、账号冷却调度，也暂未移植 external_idp / Azure Entra 登录。账号调度、限流、刷新锁和持久化使用 New API 自身机制。

## 开发与验证

```sh
npm ci
npm run check
new-api plugin lint plugin.js
new-api plugin test plugin.js --fixture test/host-fixture.json
bash scripts/test-host.sh /path/to/new-api-v1.0.0-rc.50
```

Node.js 22+；只有构建/测试需要 Node，部署仅需 New API。`npm run build` 使用 esbuild 生成单文件 ES 模块，无运行时 npm 依赖；插件不使用 Node API、全局 fetch、环境变量或共享账号状态。

宿主测试复制一个测试文件到临时参考源码，使用实际 MoeJS 和 Provider API 检查返回值，退出时删除该测试文件。CI 固定 New API 提交 `f2aa91232ed3e5878a614762ace6736a2b74257f`；三平台执行协议/认证测试，Linux 执行宿主测试。所有凭据都是测试占位符，不访问真实 Kiro。

协议基线：kiro4cpa-plugin `1582a9c`；kiro.rs `7dfb2c2`。MIT 许可与上游归属见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。本仓库不打包 New API 服务端源码，宿主遵循其自身许可。
