import {
  settings,
  SOCIAL_ARN,
  IDC_ARN,
  object,
  validBase64,
  estimate,
  base,
  clone,
} from "./common.js";

function schema(value) {
  const result = object(value) ? clone(value) : {};
  if (!result.type) result.type = "object";
  if (!object(result.properties)) result.properties = {};
  result.required = Array.isArray(result.required)
    ? result.required.filter((v) => typeof v === "string")
    : [];
  if (
    typeof result.additionalProperties !== "boolean" &&
    !object(result.additionalProperties)
  )
    result.additionalProperties = true;
  return result;
}

function conversationId(req) {
  const userId = String(req.metadata?.user_id || "");
  let candidate = "";
  try {
    candidate = JSON.parse(userId).session_id || "";
  } catch {
    candidate = userId.match(/session_([a-fA-F0-9-]{36})/)?.[1] || "";
  }
  return /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(
    candidate,
  )
    ? candidate
    : utils.uuid();
}

export function profile(ctx, fallback = true) {
  const cfg = settings(ctx);
  if (cfg.credentialType === "api_key") return "";
  const arn = String(cfg.profileArn || "").trim();
  if (
    arn &&
    !/^arn:aws:codewhisperer:[a-z0-9-]+:\d{12}:profile\/[A-Za-z0-9_-]+$/.test(
      arn,
    )
  )
    throw new Error("Invalid channel Profile ARN");
  return (
    arn ||
    (fallback ? (cfg.credentialType === "social" ? SOCIAL_ARN : IDC_ARN) : "")
  );
}
export function blocks(content) {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content
      : [];
}
export function textOf(content) {
  return blocks(content)
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n");
}
function image(source) {
  const format = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  }[source?.media_type];
  if (!format || !validBase64(source?.data))
    throw new Error(
      "Images require valid inline base64 JPEG, PNG, GIF or WebP",
    );
  return { format, source: { bytes: source.data } };
}
function chatContent(content) {
  if (typeof content === "string") return blocks(content);
  return (content || []).map((b) => {
    if (b.type === "text") return b;
    if (b.type === "image_url") {
      const match = String(b.image_url?.url || "").match(
        /^data:(image\/[a-z]+);base64,(.+)$/s,
      );
      if (!match)
        throw new Error("Remote image URLs are unsupported; use inline base64");
      return {
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      };
    }
    throw new Error("Unsupported chat content type");
  });
}
// The host's Responses converter supplies Chat Completions to this route.
export function chatToClaude(req) {
  const system = [],
    messages = [];
  for (const m of req.messages || []) {
    if (m.role === "system" || m.role === "developer") {
      system.push(textOf(chatContent(m.content)));
      continue;
    }
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content || "",
          },
        ],
      });
      continue;
    }
    const content = chatContent(m.content);
    for (const t of m.tool_calls || []) {
      let input;
      try {
        input = JSON.parse(t.function.arguments || "{}");
      } catch {
        throw new Error("Tool history arguments must be a JSON object");
      }
      content.push({
        type: "tool_use",
        id: t.id,
        name: t.function.name,
        input,
      });
    }
    messages.push({ role: m.role, content });
  }
  return {
    ...req,
    system: system.join("\n"),
    messages,
    tools: (req.tools || []).map((t) => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters,
    })),
    ...(req.reasoning_effort
      ? {
          thinking: {
            type: req.reasoning_effort === "none" ? "disabled" : "enabled",
          },
          output_config: { effort: req.reasoning_effort },
        }
      : {}),
  };
}
function byteLength(s) {
  let n = 0;
  for (const c of s) {
    const p = c.codePointAt(0);
    n += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4;
  }
  return n;
}
function toolName(name, names) {
  if (typeof name !== "string" || !name)
    throw new Error("Tools require a name");
  let short = name;
  if (byteLength(name) > 63) {
    let prefix = "";
    for (const c of name) {
      if (byteLength(prefix + c) > 54) break;
      prefix += c;
    }
    short = prefix + "_" + utils.sha256(name).slice(0, 8);
  }
  if (Object.hasOwn(names, short) && names[short] !== name)
    throw new Error("Tool name collision");
  names[short] = name;
  return short;
}
export function historyReasoning(content) {
  const candidates = content.filter((b) =>
    ["thinking", "redacted_thinking"].includes(b.type),
  );
  if (candidates.length !== 1) return undefined;
  const b = candidates[0];
  if (b.type === "redacted_thinking")
    return validBase64(b.data) ? { redactedContent: b.data } : undefined;
  if (
    typeof b.thinking === "string" &&
    b.thinking.trim() &&
    typeof b.signature === "string" &&
    b.signature.trim() &&
    b.signature !== "kiro-rs-thinking-signature"
  )
    return { reasoningText: { text: b.thinking, signature: b.signature } };
}
export function reasoning(req, model, suffix) {
  const gpt = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].includes(model),
    grok = model === "grok-4.7";
  const native =
    gpt ||
    grok ||
    [
      "claude-opus-4.6",
      "claude-opus-4.7",
      "claude-opus-4.8",
      "claude-sonnet-4.6",
    ].includes(model) ||
    /^claude-(?:fable-5|mythos-5|sonnet-5|opus-5|haiku-5|5)(?:$|[.-])/.test(
      model,
    );
  const enabled =
    req.thinking?.type !== "disabled" &&
    (suffix || ["enabled", "adaptive"].includes(req.thinking?.type));
  const budget = Math.min(
    24576,
    Math.max(1, Number(req.thinking?.budget_tokens) || 20000),
  );
  let effort = String(
    req.output_config?.effort ||
      (budget <= 4000 ? "low" : budget <= 16000 ? "medium" : "high"),
  )
    .toLowerCase()
    .trim()
    .replace(/^x[-_]high$/, "xhigh");
  if (
    !["none", "low", "medium", "high", "xhigh", "max"].includes(effort) ||
    (effort === "none" && !gpt)
  )
    effort = "high";
  if (effort === "max" && grok) effort = "xhigh";
  if (
    effort === "xhigh" &&
    ["claude-opus-4.6", "claude-sonnet-4.6"].includes(model)
  )
    effort = "high";
  const fields =
    native &&
    req.thinking?.type !== "disabled" &&
    (enabled || req.output_config?.effort) &&
    (model !== "claude-opus-4.6" || req.thinking?.type === "adaptive")
      ? { [gpt || grok ? "reasoning" : "output_config"]: { effort } }
      : undefined;
  const prefix =
    !enabled || fields
      ? ""
      : native || req.thinking?.type === "adaptive"
        ? "<thinking_mode>adaptive</thinking_mode><thinking_effort>" +
          effort +
          "</thinking_effort>"
        : "<thinking_mode>enabled</thinking_mode><max_thinking_length>" +
          budget +
          "</max_thinking_length>";
  return { enabled, fields, prefix };
}
function user(content, model) {
  const texts = [],
    images = [],
    results = [];
  for (const b of content) {
    if (b.type === "text") texts.push(String(b.text || ""));
    else if (b.type === "image") images.push(image(b.source));
    else if (b.type === "tool_result" && b.tool_use_id) {
      const resultBlocks = blocks(b.content);
      for (const nested of resultBlocks)
        if (nested.type === "image") images.push(image(nested.source));
      results.push({
        toolUseId: b.tool_use_id,
        content: [
          {
            text: typeof b.content === "string" ? b.content : textOf(b.content),
          },
        ],
        status: b.is_error ? "error" : "success",
      });
    } else if (!["thinking", "redacted_thinking"].includes(b.type))
      throw new Error("Unsupported user content type");
  }
  return {
    content: texts.join("\n"),
    modelId: model,
    origin: "AI_EDITOR",
    ...(images.length ? { images } : {}),
    ...(results.length
      ? { userInputMessageContext: { toolResults: results } }
      : {}),
  };
}
function assistant(content, names) {
  const toolUses = content
    .filter((b) => b.type === "tool_use" && b.id && b.name)
    .map((b) => {
      if (b.input != null && !object(b.input))
        throw new Error("Tool history input must be a JSON object");
      return {
        toolUseId: b.id,
        name: toolName(b.name, names),
        input: b.input || {},
      };
    });
  const reasoningContent = historyReasoning(content);
  return {
    content: textOf(content) || " ",
    ...(toolUses.length ? { toolUses } : {}),
    ...(reasoningContent ? { reasoningContent } : {}),
  };
}
export function convertRequest(ctx, request) {
  base(ctx);
  if (!object(request.body))
    throw new Error("Expected a JSON messages request");
  const req =
    ctx.path === "/v1/responses" ? chatToClaude(request.body) : request.body;
  let model = String(request.model || req.model || ""),
    suffix = false;
  if (model.endsWith("-thinking")) {
    model = model.slice(0, -9);
    suffix = true;
  }
  // Kiro uses dotted model revisions; keep live IDs and GPT/Grok names intact.
  model = model.replace(
    /^(claude-(?:opus|sonnet|haiku))-([45])-([0-9]+)(?:-\d{8})?$/,
    "$1-$2.$3",
  );
  if (!model) throw new Error("Model is required");
  const thinking = reasoning(req, model, suffix),
    names = Object.create(null);
  const tools = (req.tools || []).map((t) => ({
    toolSpecification: {
      name: toolName(t.name, names),
      description: Array.from(String(t.description || t.name))
        .slice(0, 10000)
        .join(""),
      inputSchema: {
        json: schema(t.input_schema),
      },
    },
  }));
  const messages = [];
  for (const m of req.messages || []) {
    if (!["user", "assistant"].includes(m.role))
      throw new Error("Messages must have user or assistant roles");
    if (messages.length && messages[messages.length - 1].role === m.role)
      messages[messages.length - 1].content.push(...blocks(m.content));
    else messages.push({ role: m.role, content: [...blocks(m.content)] });
  }
  while (messages.length && messages[messages.length - 1].role === "assistant")
    messages.pop();
  if (!messages.length) throw new Error("Request has no user message");
  const current = user(messages.pop().content, model),
    history = [];
  const system = textOf(req.system),
    lead =
      thinking.prefix && !/<thinking_mode>|<max_thinking_length>/.test(system)
        ? [thinking.prefix, system].filter(Boolean).join("\n")
        : system;
  if (lead)
    history.push(
      { userInputMessage: user(blocks(lead), model) },
      {
        assistantResponseMessage: {
          content: "I will follow these instructions.",
        },
      },
    );
  for (const m of messages)
    history.push(
      m.role === "user"
        ? { userInputMessage: user(m.content, model) }
        : { assistantResponseMessage: assistant(m.content, names) },
    );
  // Keep only matched calls/results, including historical orphan results.
  const pending = new Set(),
    answered = new Set();
  for (const h of [...history, { userInputMessage: current }]) {
    for (const t of h.assistantResponseMessage?.toolUses || [])
      pending.add(t.toolUseId);
    const context = h.userInputMessage?.userInputMessageContext;
    if (context)
      context.toolResults = context.toolResults.filter((t) => {
        if (!pending.has(t.toolUseId)) return false;
        pending.delete(t.toolUseId);
        answered.add(t.toolUseId);
        return true;
      });
  }
  for (const h of history)
    if (h.assistantResponseMessage?.toolUses)
      h.assistantResponseMessage.toolUses =
        h.assistantResponseMessage.toolUses.filter((t) =>
          answered.has(t.toolUseId),
        );
  const defined = new Set(
    tools.map((t) => t.toolSpecification.name.toLowerCase()),
  );
  for (const h of history)
    for (const t of h.assistantResponseMessage?.toolUses || [])
      if (!defined.has(t.name.toLowerCase())) {
        tools.push({
          toolSpecification: {
            name: t.name,
            description: "Tool from conversation history",
            inputSchema: { json: schema({}) },
          },
        });
        defined.add(t.name.toLowerCase());
      }
  current.userInputMessageContext = {
    ...(current.userInputMessageContext || {}),
    envState: { operatingSystem: "macos", currentWorkingDirectory: "/" },
    ...(tools.length ? { tools } : {}),
  };
  const arn = profile(ctx),
    body = {
      conversationState: {
        conversationId: conversationId(req),
        agentContinuationId: utils.uuid(),
        agentTaskType: "vibe",
        chatTriggerType: "MANUAL",
        currentMessage: { userInputMessage: current },
        ...(history.length ? { history } : {}),
      },
      ...(arn ? { profileArn: arn } : {}),
      ...(thinking.fields
        ? { additionalModelRequestFields: thinking.fields }
        : {}),
    };
  // Retain a retry body only when it contains signed history. Drop it on first stream event.
  const signed = history.some(
    (h) => h.assistantResponseMessage?.reasoningContent,
  );
  return {
    body,
    path: "/generateAssistantResponse",
    method: "POST",
    stream: true,
    state: {
      model,
      clientStream: Boolean(request.stream),
      chat: ctx.path === "/v1/responses",
      thinking: thinking.enabled,
      names,
      inputTokens: estimate(JSON.stringify(req)),
      ...(signed ? { retryBody: body } : {}),
    },
  };
}
