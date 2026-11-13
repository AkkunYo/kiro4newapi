import {
  base,
  query,
  json,
  clone,
  codeOf,
  tokenRejected,
  upstreamError,
} from "./common.js";
import { profile } from "./request.js";

function attempts(ctx, kind) {
  const primary = base(ctx),
    arn = profile(ctx, false),
    urls = [];
  const regions = [
    primary,
    ...[
      "https://q.us-east-1.amazonaws.com",
      "https://q.eu-central-1.amazonaws.com",
    ].filter((v) => v !== primary),
  ];
  // Model fetching starts at the manifest URL, without a profile.
  for (const endpoint of regions)
    for (const p of arn ? ["", arn] : [""])
      urls.push(
        endpoint +
          (kind === "models" ? "/ListAvailableModels?" : "/getUsageLimits?") +
          query({
            origin: "AI_EDITOR",
            ...(kind === "balance" ? { resourceType: "AGENTIC_REQUEST" } : {}),
            profileArn: p,
          }),
      );
  return urls;
}
function fallback(ctx, response, kind) {
  const state = ctx.state || {},
    urls = attempts(ctx, kind),
    attempt = state.attempt || 0;
  const retry =
    !tokenRejected(response.status, response.body) &&
    (response.status === 403 ||
      (response.status === 400 &&
        /Invalid profileArn|Improperly formed request/.test(
          response.body || "",
        )));
  if (retry && attempt + 1 < urls.length)
    return {
      next: { url: urls[attempt + 1], method: "GET" },
      state: { attempt: attempt + 1 },
    };
}
function models(ctx, response) {
  if (response.status < 200 || response.status >= 300)
    return (
      fallback(ctx, response, "models") ||
      upstreamError(response.status, response.body)
    );
  const data = json(response.body),
    state = ctx.state || {};
  if (!Array.isArray(data?.models)) return upstreamError(502, "");
  const all = [
    ...(state.models || []),
    ...data.models
      .filter((m) => typeof m.modelId === "string" && m.modelId)
      .map((m) => ({
        id: m.modelId,
        object: "model",
        created: 0,
        owned_by: "kiro",
        name: m.modelName || m.modelId,
        ...(m.description ? { description: m.description } : {}),
        ...(Number.isFinite(m.tokenLimits?.maxInputTokens)
          ? { context_length: m.tokenLimits.maxInputTokens }
          : {}),
        ...(Number.isFinite(m.tokenLimits?.maxOutputTokens)
          ? { max_output_tokens: m.tokenLimits.maxOutputTokens }
          : {}),
      })),
  ];
  if (data.nextToken) {
    const seen = state.seen || [];
    if (seen.includes(data.nextToken) || seen.length >= 9)
      return {
        error: {
          status: 502,
          message: "Kiro model pagination did not terminate",
        },
      };
    return {
      next: {
        url:
          attempts(ctx, "models")[state.attempt || 0] +
          "&" +
          query({ nextToken: data.nextToken }),
        method: "GET",
      },
      state: { ...state, models: all, seen: [...seen, data.nextToken] },
    };
  }
  if (!all.length)
    return {
      error: { status: 502, message: "Kiro returned an empty model list" },
    };
  return {
    body: {
      object: "list",
      data: all.filter((m, i) => all.findIndex((n) => n.id === m.id) === i),
    },
  };
}
export function convertResponse(ctx, response) {
  if (ctx.path === "/v1/models") return models(ctx, response);
  const code =
    typeof response.body === "string" &&
    response.body.trim() === "THINKING_SIGNATURE_INVALID"
      ? "THINKING_SIGNATURE_INVALID"
      : codeOf(response.body);
  if (
    response.status === 400 &&
    code === "THINKING_SIGNATURE_INVALID" &&
    ctx.state?.retryBody &&
    !ctx.state.signatureRetried
  ) {
    const state = clone(ctx.state),
      body = state.retryBody;
    delete state.retryBody;
    state.signatureRetried = true;
    for (const h of body.conversationState.history || [])
      if (h.assistantResponseMessage)
        delete h.assistantResponseMessage.reasoningContent;
    return {
      next: {
        body,
        path: "/generateAssistantResponse",
        method: "POST",
        stream: true,
      },
      state,
    };
  }
  // A successful generation must be an event stream; never forward an opaque vendor body.
  return upstreamError(
    response.status >= 400 ? response.status : 502,
    response.body,
  );
}
export function buildBalanceRequest(ctx) {
  return {
    url: attempts(ctx, "balance")[0],
    method: "GET",
    state: { attempt: 0 },
  };
}
export function parseBalance(ctx, response) {
  if (response.status < 200 || response.status >= 300)
    return (
      fallback(ctx, response, "balance") || {
        error: upstreamError(response.status, response.body).error.message,
      }
    );
  const data = json(response.body),
    windows = [];
  function add(name, used, limit, resetAt) {
    if (
      !Number.isFinite(used) ||
      !Number.isFinite(limit) ||
      used < 0 ||
      limit < 0
    )
      throw new Error("Invalid Kiro quota values");
    windows.push({
      name: { en: name, zh: name },
      used,
      limit,
      unit: "Credit",
      ...(Number.isFinite(resetAt) && resetAt > 0
        ? { resetAt: Math.floor(resetAt) }
        : {}),
    });
  }
  for (const item of data?.usageBreakdownList || []) {
    const name = String(
      item.displayName || item.resourceType || "Credit",
    ).slice(0, 80);
    add(
      name + " · monthly",
      item.currentUsageWithPrecision,
      item.usageLimitWithPrecision,
      item.nextDateReset,
    );
    const trial = item.freeTrialInfo;
    if (
      trial?.freeTrialStatus === "ACTIVE" &&
      trial.usageLimitWithPrecision > 0
    )
      add(
        name + " · trial",
        trial.currentUsageWithPrecision,
        trial.usageLimitWithPrecision,
        trial.freeTrialExpiry,
      );
    for (const b of item.bonuses || [])
      if (b.status === "ACTIVE" && b.usageLimit > 0)
        add(
          String(b.displayName || name + " · bonus").slice(0, 100),
          b.currentUsage,
          b.usageLimit,
          b.expiresAt,
        );
  }
  if (!windows.length) return { error: "Kiro did not return usage data" };
  if (windows.length > 32)
    return { error: "Kiro returned too many quota windows" };
  return { windows };
}
