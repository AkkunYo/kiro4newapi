import { clone, json, object, validBase64 } from "./common.js";
import { parseThinking } from "./thinking.js";

const failure = (message) => ({
  error: {
    status: 502,
    type: "api_error",
    code: "kiro_invalid_stream",
    message,
  },
});
function usage(s) {
  const u = s.usage;
  return u
    ? {
        input_tokens: u.uncachedInputTokens || 0,
        output_tokens: u.outputTokens || 0,
        cache_read_input_tokens: u.cacheReadInputTokens || 0,
        cache_creation_input_tokens: u.cacheWriteInputTokens || 0,
      }
    : {
        input_tokens: s.inputTokens,
        output_tokens: s.outputChars
          ? Math.ceil((s.outputCJK * 2) / 3) +
            Math.ceil((s.outputChars - s.outputCJK) / 4)
          : 0,
      };
}
function chatUsage(u) {
  const prompt =
    u.input_tokens +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output_tokens,
    total_tokens: prompt + u.output_tokens,
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 },
  };
}
function stopReason(s) {
  if (s.stop === "CONTENT_FILTERED") return "refusal";
  if (
    ["MAX_TOKENS", "MODEL_CONTEXT_WINDOW_EXCEEDED", "STOP_SEQUENCE"].includes(
      s.stop,
    )
  )
    return s.stop.toLowerCase();
  if (!s.stop && s.contextFull) return "model_context_window_exceeded";
  return s.tools.length ? "tool_use" : "end_turn";
}
function chatStop(reason) {
  return reason === "tool_use"
    ? "tool_calls"
    : ["max_tokens", "model_context_window_exceeded"].includes(reason)
      ? "length"
      : reason === "refusal"
        ? "content_filter"
        : "stop";
}
function count(s, text) {
  for (const c of text) {
    s.outputChars++;
    if (c >= "\u4e00" && c <= "\u9fff") s.outputCJK++;
  }
}
function message(s) {
  return {
    id: s.id,
    type: "message",
    role: "assistant",
    model: s.model,
    content: s.content,
    stop_reason: stopReason(s),
    stop_sequence: null,
    usage: usage(s),
  };
}
function chatMessage(s) {
  const text = s.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
    reasoning = s.content
      .filter((b) => b.type === "thinking")
      .map((b) => b.thinking)
      .join("");
  const tool_calls = s.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));
  return {
    id: s.id,
    object: "chat.completion",
    created: s.created,
    model: s.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(tool_calls.length ? { tool_calls } : {}),
        },
        finish_reason: chatStop(stopReason(s)),
      },
    ],
    usage: chatUsage(usage(s)),
  };
}
export function convertStreamEvent(ctx, input) {
  if (!ctx.state) return failure("Missing Kiro request state");
  const s = clone(ctx.state),
    out = [];
  delete s.retryBody;
  if (!s.id)
    Object.assign(s, {
      id: "msg_" + utils.uuid().replace(/-/g, ""),
      created: utils.unixNow(),
      content: [],
      tools: [],
      toolCursor: 0,
      held: [],
      open: -1,
      parser: "",
      inThinking: false,
      outputChars: 0,
      outputCJK: 0,
    });
  function emit(type, data) {
    if (!s.clientStream) return;
    if (!s.chat) {
      out.push({ event: type, data: clone({ type, ...data }) });
      return;
    }
    const chunk = {
      id: s.id,
      object: "chat.completion.chunk",
      created: s.created,
      model: s.model,
      choices: [],
    };
    let delta = {},
      finish = null;
    if (type === "message_start") delta = { role: "assistant", content: "" };
    else if (
      type === "content_block_start" &&
      data.content_block.type === "tool_use"
    ) {
      const b = data.content_block;
      delta = {
        tool_calls: [
          {
            index: s.chatToolIndex || 0,
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: "" },
          },
        ],
      };
    } else if (type === "content_block_delta") {
      const d = data.delta;
      if (d.type === "text_delta") delta = { content: d.text };
      else if (d.type === "thinking_delta")
        delta = { reasoning_content: d.thinking };
      else if (d.type === "input_json_delta")
        delta = {
          tool_calls: [
            {
              index: s.chatToolIndex || 0,
              function: { arguments: d.partial_json },
            },
          ],
        };
      else return;
    } else if (type === "message_delta") {
      finish = chatStop(data.delta.stop_reason);
      chunk.usage = chatUsage(data.usage);
    } else if (type === "message_stop") {
      out.push({ data: "[DONE]" });
      return;
    } else return;
    chunk.choices = [{ index: 0, delta, finish_reason: finish }];
    out.push({ data: chunk });
  }
  function close() {
    if (s.open < 0) return;
    const block = s.content[s.open];
    if (block.type === "thinking" && block.signature)
      emit("content_block_delta", {
        index: s.open,
        delta: { type: "signature_delta", signature: block.signature },
      });
    emit("content_block_stop", { index: s.open });
    s.open = -1;
  }
  function append(kind, text) {
    if (!text || (kind === "thinking" && !s.thinking)) return;
    if (s.open < 0 || s.content[s.open].type !== kind) {
      close();
      s.open = s.content.length;
      const block =
        kind === "thinking"
          ? { type: kind, thinking: "", signature: "" }
          : { type: kind, text: "" };
      s.content.push(block);
      emit("content_block_start", { index: s.open, content_block: block });
    }
    s.content[s.open][kind === "thinking" ? "thinking" : "text"] += text;
    emit("content_block_delta", {
      index: s.open,
      delta:
        kind === "thinking"
          ? { type: "thinking_delta", thinking: text }
          : { type: "text_delta", text },
    });
  }
  function parseText(text, flush = false) {
    if (!s.thinking) {
      append("text", text);
      return;
    }
    parseThinking(s, text, flush, append, close);
  }
  function content(event, data) {
    if (event === "assistantResponseEvent") {
      const t = typeof data.content === "string" ? data.content : "";
      count(s, t);
      parseText(t);
    }
    if (event === "reasoningContentEvent") {
      parseText("", true);
      const t = typeof data.text === "string" ? data.text : "";
      count(s, t);
      append("thinking", t);
      if (s.thinking && data.signature) {
        const block = [...s.content]
          .reverse()
          .find((b) => b.type === "thinking");
        if (block) block.signature = String(data.signature);
      }
      if (s.thinking && validBase64(data.redactedContent)) {
        close();
        const index = s.content.length,
          block = { type: "redacted_thinking", data: data.redactedContent };
        s.content.push(block);
        emit("content_block_start", { index, content_block: block });
        emit("content_block_stop", { index });
      }
    }
  }
  function drain() {
    while (s.toolCursor < s.tools.length) {
      const tool = s.tools[s.toolCursor];
      if (!tool.stopped || !tool.name) break;
      let args;
      try {
        args = JSON.parse(tool.input || "{}");
      } catch {
        throw new Error("Kiro returned malformed tool arguments");
      }
      if (!object(args))
        throw new Error("Kiro tool arguments must be a JSON object");
      parseText("", true);
      close();
      const index = s.content.length;
      const block = {
        type: "tool_use",
        id: tool.id,
        name: Object.hasOwn(s.names, tool.name)
          ? s.names[tool.name]
          : tool.name,
        input: args,
      };
      s.content.push(block);
      s.chatToolIndex = s.toolCursor;
      emit("content_block_start", {
        index,
        content_block: { ...block, input: {} },
      });
      emit("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
      });
      emit("content_block_stop", { index });
      s.toolCursor++;
    }
    if (s.toolCursor === s.tools.length) {
      const held = s.held;
      s.held = [];
      for (const item of held) content(item.event, item.data);
    }
  }
  try {
    if (input.done) {
      if (!s.started) {
        emit("message_start", {
          message: {
            ...message(s),
            content: [],
            stop_reason: null,
            usage: { input_tokens: s.inputTokens, output_tokens: 0 },
          },
        });
        s.started = true;
      }
      if (s.stop === "CONTENT_FILTERED" && s.tools.length)
        return failure("Kiro refused a response containing tool calls");
      for (const t of s.tools) {
        if (!t.name || (!t.stopped && t.input.trim()))
          return failure("Kiro tool stream ended before completion");
        t.stopped = true;
      }
      drain();
      parseText("", true);
      close();
      emit("message_delta", {
        delta: { stop_reason: stopReason(s), stop_sequence: null },
        usage: usage(s),
      });
      emit("message_stop", {});
      return s.clientStream
        ? { events: out, state: s }
        : { body: s.chat ? chatMessage(s) : message(s), state: s };
    }
    const data = json(input.data || "{}", "Kiro stream event");
    if (!object(data)) return failure("Invalid Kiro stream event");
    const event = input.event || "";
    if (event === "ContentLengthExceededException") s.stop = "MAX_TOKENS";
    else if (/(?:Exception|Error|error)$/.test(event))
      return failure(
        "Kiro stream failed: " +
          (/^[A-Za-z0-9_]{1,80}$/.test(event) ? event : "upstream error"),
      );
    else if (event === "metadataEvent") {
      if (data.tokenUsage) {
        const u = data.tokenUsage;
        if (
          [
            "uncachedInputTokens",
            "outputTokens",
            "cacheReadInputTokens",
            "cacheWriteInputTokens",
          ].some(
            (k) =>
              u[k] !== undefined &&
              (!Number.isSafeInteger(u[k]) || u[k] < 0 || u[k] > 2147483647),
          )
        )
          return failure("Invalid Kiro token usage");
        s.usage = u;
      }
      if (data.stopReason) s.stop = String(data.stopReason).toUpperCase();
    } else if (event === "contextUsageEvent")
      s.contextFull = s.contextFull || data.contextUsagePercentage >= 100;
    else if (event === "toolUseEvent") {
      if (s.stop === "CONTENT_FILTERED")
        return failure("Kiro returned a tool after refusing the request");
      if (
        typeof data.toolUseId !== "string" ||
        !data.toolUseId ||
        data.toolUseId.length > 256
      )
        return failure("Kiro tool event has invalid ID");
      if (
        data.name !== undefined &&
        (typeof data.name !== "string" || data.name.length > 256)
      )
        return failure("Kiro tool event has invalid name");
      let t = s.tools.find((t) => t.id === data.toolUseId);
      if (!t) {
        if (s.tools.length >= 128) return failure("Too many Kiro tool calls");
        t = { id: data.toolUseId, name: "", input: "", stopped: false };
        s.tools.push(t);
      }
      if (t.stopped && (data.input || (data.name && data.name !== t.name)))
        return failure("Kiro modified a completed tool");
      if (data.name) {
        if (t.name && t.name !== data.name)
          return failure("Kiro tool name changed mid-stream");
        t.name = data.name;
      }
      if (data.input !== undefined && typeof data.input !== "string")
        return failure("Invalid Kiro tool argument fragment");
      t.input += data.input || "";
      count(s, data.input || "");
      t.stopped = t.stopped || data.stop === true;
    }
    if (!s.started) {
      emit("message_start", {
        message: {
          ...message(s),
          content: [],
          stop_reason: null,
          usage: { input_tokens: s.inputTokens, output_tokens: 0 },
        },
      });
      s.started = true;
    }
    if (["assistantResponseEvent", "reasoningContentEvent"].includes(event)) {
      if (s.toolCursor < s.tools.length) s.held.push({ event, data });
      else content(event, data);
    }
    drain();
    if (JSON.stringify(s).length > 4 * 1024 * 1024)
      return failure("Kiro response exceeds the plugin buffer limit");
    return { events: out, state: s };
  } catch (error) {
    return failure(
      error.message === "Kiro returned malformed tool arguments" ||
        error.message === "Kiro tool arguments must be a JSON object"
        ? error.message
        : "Invalid Kiro stream payload",
    );
  }
}
