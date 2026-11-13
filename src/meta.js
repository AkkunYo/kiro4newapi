import { PLUGIN_KEY, VERSION, AUTH_REGIONS } from "./common.js";
export const meta = {
  apiVersion: 1,
  key: PLUGIN_KEY,
  name: "Kiro",
  version: VERSION,
  author: { name: "AkkunYo", url: "https://github.com/AkkunYo" },
  website: "https://github.com/AkkunYo/kiro4newapi",
  description: {
    en: "Kiro models, OAuth login, token refresh and credit quotas",
    zh: "Kiro 模型、登录授权、Token 刷新与 Credit 额度",
  },
  icon: "text:K",
  baseUrl: "https://q.us-east-1.amazonaws.com",
  allowedHosts: [
    "app.kiro.dev",
    "q.us-east-1.amazonaws.com",
    "q.eu-central-1.amazonaws.com",
    ...AUTH_REGIONS.map((r) => "oidc." + r + ".amazonaws.com"),
    ...AUTH_REGIONS.map((r) => "prod." + r + ".auth.desktop.kiro.dev"),
  ],
  relay: [
    {
      incoming_path: "/v1/messages",
      upstream_path: "/generateAssistantResponse",
      converter: "plugin",
    },
    {
      incoming_path: "/v1/chat/completions",
      upstream_path: "/generateAssistantResponse",
      converter: "openai_chat_completions_to_anthropic_messages+plugin",
    },
    {
      incoming_path: "/v1/responses",
      upstream_path: "/generateAssistantResponse",
      converter: "openai_responses_to_openai_chat_completions+plugin",
    },
    {
      incoming_path: "/v1/models",
      upstream_path: "/ListAvailableModels?origin=AI_EDITOR",
      converter: "plugin",
    },
  ],
  keyHint: {
    en: "For API Key channels, paste a Kiro API key. For OAuth, leave empty and use Sign in.",
    zh: "API Key 渠道填写 Kiro API Key；OAuth 渠道留空后点击登录。",
  },
  channelConfig: {
    type: "object",
    properties: {
      credentialType: {
        type: "string",
        title: { en: "Credential type", zh: "凭据类型" },
        enum: ["social", "builder-id", "iam", "api_key"],
        default: "social",
      },
      loginMode: {
        type: "string",
        title: { en: "Login mode", zh: "登录方式" },
        enum: ["browser", "import"],
        default: "browser",
      },
      authRegion: {
        type: "string",
        title: { en: "Authentication region", zh: "认证区域" },
        enum: AUTH_REGIONS,
        default: "us-east-1",
      },
      profileArn: {
        type: "string",
        title: { en: "Profile ARN (optional)", zh: "Profile ARN（可选）" },
        default: "",
      },
      startUrl: {
        type: "string",
        title: {
          en: "IAM Identity Center start URL",
          zh: "IAM Identity Center 启动地址",
        },
        default: "",
      },
      clientVersion: {
        type: "string",
        title: { en: "Kiro client version", zh: "Kiro 客户端版本" },
        default: "1.4.5",
      },
    },
  },
};
