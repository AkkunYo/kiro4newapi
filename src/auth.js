import {
  settings,
  region,
  query,
  json,
  object,
  codeOf,
  tokenRejected,
  base,
} from "./common.js";

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
function post(url, body) {
  try {
    return utils.fetch({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Kiro authentication service could not be reached");
  }
}
function checked(response) {
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      "Kiro authentication failed (HTTP " + response.status + ")",
    );
  const body = json(response.body);
  if (!object(body)) throw new Error("Invalid Kiro authentication response");
  return body;
}
function required(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value))
    throw new Error("Missing or invalid " + field);
  return value.trim();
}
export function machineId(credential, apiKey = "") {
  const supplied = String(credential?.machineId || "")
    .replace(/-/g, "")
    .toLowerCase();
  if (/^[a-f0-9]{64}$/.test(supplied)) return supplied;
  if (/^[a-f0-9]{32}$/.test(supplied)) return supplied + supplied;
  return utils.sha256(
    apiKey
      ? "KiroAPIKey/" + apiKey
      : "KotlinNativeAPI/" + required(credential?.refreshToken, "refreshToken"),
  );
}
function result(previous, body) {
  const credential = {
    ...previous,
    accessToken: required(body.accessToken, "accessToken"),
    refreshToken: body.refreshToken || previous.refreshToken,
  };
  if (body.profileArn) credential.profileArn = body.profileArn;
  credential.machineId = machineId(credential);
  const lifetime = Number(body.expiresIn);
  const expiresAt =
    utils.unixNow() +
    (Number.isFinite(lifetime) && lifetime > 0
      ? Math.min(lifetime, 86400)
      : 3600);
  credential.accountId =
    previous.accountId ||
    utils
      .sha256(credential.refreshToken || credential.accessToken)
      .slice(0, 24);
  return {
    credential,
    expiresAt,
    accountId: credential.accountId,
    label: "Kiro " + credential.type,
  };
}
function credential(ctx, data) {
  const cfg = settings(ctx);
  if (!object(data)) throw new Error("Credential must be a JSON object");
  const type = String(
    data.authMethod || data.type || cfg.credentialType,
  ).toLowerCase();
  // Accept the existing plugin's credential spelling.
  const normalized = {
    social: "social",
    idc: cfg.credentialType,
    "builder-id": "builder-id",
    iam: "iam",
  }[type];
  if (!normalized || normalized !== cfg.credentialType)
    throw new Error("Credential type must match this channel");
  const value = {
    type: normalized,
    authRegion: region(
      data.authRegion || data.idcRegion || data.region || cfg.authRegion,
    ),
    refreshToken: required(data.refreshToken, "refreshToken"),
  };
  for (const key of ["profileArn", "machineId", "tokenType"])
    if (data[key]) value[key] = required(data[key], key);
  if (normalized !== "social") {
    value.clientId = required(data.clientId, "clientId");
    value.clientSecret = required(data.clientSecret, "clientSecret");
  }
  return value;
}
export function refresh(ctx) {
  base(ctx);
  if (!ctx.credential) return { relogin: true };
  const c = credential(ctx, ctx.credential),
    r = region(c.authRegion);
  const response =
    c.type === "social"
      ? post("https://prod." + r + ".auth.desktop.kiro.dev/refreshToken", {
          refreshToken: c.refreshToken,
        })
      : post("https://oidc." + r + ".amazonaws.com/token", {
          clientId: c.clientId,
          clientSecret: c.clientSecret,
          refreshToken: c.refreshToken,
          grantType: "refresh_token",
        });
  if (
    [401, 403].includes(response.status) ||
    [
      "invalid_grant",
      "invalid_client",
      "InvalidGrantException",
      "InvalidClientException",
    ].includes(codeOf(response.body))
  )
    return { relogin: true };
  const output = result({ ...ctx.credential, ...c }, checked(response));
  // Keep account identity and fingerprint stable when refresh tokens rotate.
  output.accountId =
    ctx.credential.accountId || utils.sha256(c.refreshToken).slice(0, 24);
  output.credential.accountId = output.accountId;
  output.credential.machineId = machineId(ctx.credential);
  return output;
}
export function parseCallback(value, expectedState) {
  const match = String(value || "")
    .trim()
    .match(
      /^http:\/\/127\.0\.0\.1:3128(\/(?:oauth|signin)\/callback)\?([^#]+)$/,
    );
  if (!match)
    throw new Error(
      "Paste the complete http://127.0.0.1:3128/oauth/callback or /signin/callback URL",
    );
  const fields = {};
  try {
    for (const part of match[2].split("&")) {
      const pos = part.indexOf("="),
        key = decodeURIComponent(pos < 0 ? part : part.slice(0, pos));
      if (Object.hasOwn(fields, key)) throw new Error();
      fields[key] = decodeURIComponent(
        (pos < 0 ? "" : part.slice(pos + 1)).replace(/\+/g, " "),
      );
    }
  } catch {
    throw new Error("Malformed or duplicate callback parameters");
  }
  if (!expectedState || fields.state !== expectedState)
    throw new Error("Kiro login state mismatch; restart login");
  const code = required(fields.code, "authorization code");
  if (fields.error) throw new Error("Kiro authorization was denied");
  return {
    code,
    redirect_uri:
      "http://127.0.0.1:3128" +
      match[1] +
      (fields.login_option
        ? "?" + query({ login_option: fields.login_option })
        : ""),
  };
}
export function login(ctx, input) {
  base(ctx);
  const cfg = settings(ctx),
    r = region(cfg.authRegion),
    session = ctx.login.session;
  if (cfg.credentialType === "api_key")
    throw new Error("Paste the API key into the channel key field");
  if (cfg.loginMode === "import") {
    if (!input?.fields)
      return {
        type: "fields",
        fields: [
          {
            name: "credential",
            label: { en: "Credential JSON", zh: "凭据 JSON" },
            type: "password",
            required: true,
            description: {
              en: "refreshToken; also clientId and clientSecret for Builder ID / IAM. Secrets stay on the gateway.",
              zh: "填写 refreshToken；Builder ID / IAM 还需 clientId、clientSecret。凭据保存在网关。",
            },
          },
        ],
      };
    const c = credential(ctx, json(input.fields.credential, "Credential"));
    c.machineId = machineId(c);
    const output = refresh({ ...ctx, credential: c });
    if (output.relogin)
      throw new Error("Imported credentials were rejected; sign in again");
    return { type: "done", ...output };
  }
  if (cfg.credentialType === "social") {
    if (!input?.fields) {
      const url =
        "https://app.kiro.dev/signin?" +
        query({
          state: ctx.login.state,
          code_challenge: ctx.login.codeChallenge,
          code_challenge_method: "S256",
          redirect_uri: "http://127.0.0.1:3128",
          redirect_from: "KiroIDE",
        });
      return {
        type: "fields",
        fields: [
          {
            name: "callbackUrl",
            label: { en: "Full callback URL", zh: "完整回调地址" },
            type: "password",
            required: true,
            description: {
              en:
                "Open " +
                url +
                " ; after sign-in, paste the complete localhost URL even if the page cannot load.",
              zh:
                "打开 " +
                url +
                " ；登录后复制完整的本地回调地址，即使页面无法打开。",
            },
          },
        ],
        session: { kind: "social" },
      };
    }
    if (session?.kind !== "social") throw new Error("Restart Kiro login");
    const callback = parseCallback(input.fields.callbackUrl, ctx.login.state);
    const body = checked(
      post("https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token", {
        ...callback,
        code_verifier: ctx.login.codeVerifier,
      }),
    );
    return {
      type: "done",
      ...result({ type: "social", authRegion: "us-east-1" }, body),
    };
  }
  const oidc = "https://oidc." + r + ".amazonaws.com";
  if (input?.poll) {
    if (
      session?.kind !== "device" ||
      session.authRegion !== r ||
      session.type !== cfg.credentialType ||
      session.expiresAt <= utils.unixNow()
    )
      throw new Error("Device login expired; start again");
    const response = post(oidc + "/token", {
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      deviceCode: session.deviceCode,
      grantType: deviceGrant,
    });
    const code = codeOf(response.body);
    if (
      [
        "authorization_pending",
        "slow_down",
        "AuthorizationPendingException",
        "SlowDownException",
      ].includes(code)
    )
      return {
        type: "pending",
        interval: Math.min(
          60,
          session.interval + (code.toLowerCase().includes("slow") ? 5 : 0),
        ),
        session: {
          ...session,
          interval: Math.min(
            60,
            session.interval + (code.toLowerCase().includes("slow") ? 5 : 0),
          ),
        },
      };
    return {
      type: "done",
      ...result(
        {
          type: session.type,
          authRegion: r,
          clientId: session.clientId,
          clientSecret: session.clientSecret,
        },
        checked(response),
      ),
    };
  }
  const startUrl =
    cfg.credentialType === "builder-id"
      ? "https://view.awsapps.com/start"
      : String(cfg.startUrl).trim();
  if (!/^https:\/\/[a-zA-Z0-9-]+\.awsapps\.com\/start\/?$/.test(startUrl))
    throw new Error(
      "IAM start URL must be https://<directory>.awsapps.com/start",
    );
  const client = checked(
    post(oidc + "/client/register", {
      clientName: "Kiro CLI",
      clientType: "public",
      scopes: [
        "codewhisperer:completions",
        "codewhisperer:analysis",
        "codewhisperer:conversations",
      ],
      grantTypes: [deviceGrant, "refresh_token"],
      issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
    }),
  );
  const clientId = required(client.clientId, "clientId"),
    clientSecret = required(client.clientSecret, "clientSecret");
  const device = checked(
    post(oidc + "/device_authorization", { clientId, clientSecret, startUrl }),
  );
  const expiresIn = Math.min(
      3600,
      Math.max(1, Number(device.expiresIn) || 600),
    ),
    interval = Math.min(60, Math.max(1, Number(device.interval) || 5));
  return {
    type: "device",
    userCode: required(device.userCode, "userCode"),
    verificationUri: required(device.verificationUri, "verificationUri"),
    ...(device.verificationUriComplete
      ? { verificationUriComplete: device.verificationUriComplete }
      : {}),
    interval,
    expiresIn,
    session: {
      kind: "device",
      type: cfg.credentialType,
      authRegion: r,
      clientId,
      clientSecret,
      deviceCode: required(device.deviceCode, "deviceCode"),
      interval,
      expiresAt: utils.unixNow() + expiresIn,
    },
  };
}
export function signRequest(ctx) {
  base(ctx);
  const cfg = settings(ctx),
    c = ctx.credential;
  if (!c && cfg.credentialType !== "api_key")
    throw new Error("OAuth channels require Sign in or credential import");
  if (c && c.type !== cfg.credentialType)
    throw new Error("Credential type must match this channel");
  const key = required(c ? c.accessToken : ctx.apiKey, "access token"),
    id = machineId(c, c ? "" : key);
  const version = /^[\d.]{1,32}$/.test(cfg.clientVersion)
    ? cfg.clientVersion
    : "1.4.5";
  const headers = {
    Authorization: "Bearer " + key,
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
    "x-amz-user-agent": "aws-sdk-js/1.0.34 KiroIDE-" + version + "-" + id,
    "User-Agent":
      "aws-sdk-js/1.0.34 ua/2.1 os/darwin lang/js md/nodejs#22.19.0 api/codewhispererstreaming#1.0.34 m/E KiroIDE-" +
      version +
      "-" +
      id,
    "amz-sdk-invocation-id": utils.uuid(),
    "amz-sdk-request": "attempt=1; max=3",
  };
  if (!c) headers.tokentype = "API_KEY";
  else if (String(c.tokenType).toUpperCase() === "EXTERNAL_IDP")
    headers.tokentype = "EXTERNAL_IDP";
  return { headers };
}
export function credentialRejected(_ctx, response) {
  return tokenRejected(response.status, response.body);
}
export function checkKey(ctx, key) {
  if (settings(ctx).credentialType !== "api_key")
    return {
      error: {
        en: "Use Sign in for OAuth credentials",
        zh: "OAuth 凭据请使用登录功能",
      },
    };
  if (!String(key).trim() || /[\s{}]/.test(key))
    return {
      error: {
        en: "Enter a single Kiro API key",
        zh: "请输入单个 Kiro API Key",
      },
    };
}
