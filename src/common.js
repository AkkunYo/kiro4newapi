export const PLUGIN_KEY = "akkunyo-kiro";
export const VERSION = "0.1.0";
export const SOCIAL_ARN =
  "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";
export const IDC_ARN =
  "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const AUTH_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "ap-south-1",
  "ap-south-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ca-central-1",
  "ca-west-1",
  "sa-east-1",
  "af-south-1",
  "me-south-1",
  "me-central-1",
  "il-central-1",
];
export const defaults = {
  credentialType: "social",
  loginMode: "browser",
  authRegion: "us-east-1",
  profileArn: "",
  startUrl: "",
  clientVersion: "1.4.5",
};
export function settings(ctx) {
  return { ...defaults, ...(ctx.config || {}) };
}
export function query(values) {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(
      ([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)),
    )
    .join("&");
}
export function region(value) {
  if (!AUTH_REGIONS.includes(value))
    throw new Error("Unsupported AWS authentication region");
  return value;
}
export function base(ctx) {
  const value = String(
    ctx.baseUrl || "https://q.us-east-1.amazonaws.com",
  ).replace(/\/+$/, "");
  if (!/^https:\/\/q\.[a-z]{2}(?:-[a-z]+)+-\d\.amazonaws\.com$/.test(value))
    throw new Error(
      "Base URL must be an HTTPS Kiro q.<region>.amazonaws.com endpoint",
    );
  return value;
}
export function json(value, label = "Kiro response") {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(label + " is not valid JSON");
  }
}
export function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
export function codeOf(body) {
  const data =
    typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body);
          } catch {
            return {};
          }
        })()
      : body;
  return object(data)
    ? String(data.reason || data.code || data.__type || data.error || "")
    : "";
}
export function tokenRejected(status, body) {
  return (
    status === 401 ||
    (status === 403 &&
      String(typeof body === "string" ? body : JSON.stringify(body)).includes(
        "The bearer token included in the request is invalid",
      ))
  );
}
export function upstreamError(status, body) {
  const code = codeOf(body);
  if (tokenRejected(status, body))
    return {
      error: {
        status: 401,
        type: "authentication_error",
        code: "kiro_token_invalid",
        message: "Kiro credentials have expired; refresh or sign in again",
      },
    };
  if (status === 402)
    return {
      error: {
        status: 402,
        code: "kiro_quota_exhausted",
        message: "Kiro account quota is exhausted",
      },
    };
  if (status === 403)
    return {
      error: {
        status: 403,
        code: "kiro_forbidden",
        message: "Kiro denied this account or model",
      },
    };
  if (status === 429)
    return {
      error: {
        status: 429,
        code: "kiro_rate_limited",
        message: "Kiro rate limit reached",
      },
    };
  return {
    error: {
      status: status >= 500 ? 502 : status >= 400 ? status : 502,
      code: [
        "THINKING_SIGNATURE_INVALID",
        "ValidationException",
        "ContentLengthExceededException",
      ].includes(code)
        ? code
        : "kiro_upstream_error",
      message: "Kiro request failed" + (status ? " (HTTP " + status + ")" : ""),
    },
  };
}
export function validBase64(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ) &&
    !(
      (value.endsWith("==") &&
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
          value[value.length - 3],
        ) % 16) ||
      (value.endsWith("=") &&
        !value.endsWith("==") &&
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
          value[value.length - 2],
        ) % 4)
    )
  );
}
export function estimate(text) {
  let cjk = 0,
    other = 0;
  for (const ch of String(text)) {
    if (ch >= "\u4e00" && ch <= "\u9fff") cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil((cjk * 2) / 3) + Math.ceil(other / 4));
}
