import test from "node:test";
import assert from "node:assert/strict";
import * as plugin from "../src/plugin.js";
import { historyReasoning } from "../src/request.js";
import { ctx, req, ev, setup, runStream } from "./helpers.mjs";
setup();

test("Chat and Responses preserve explicit native effort and cache writes", () => {
  for (const path of ["/v1/chat/completions", "/v1/responses"])
    for (const [model, effort, want] of [
      ["grok-4.7", "high", "high"],
      ["grok-4.7", "max", "xhigh"],
      ["gpt-5.6-sol", "none", "none"],
    ]) {
      const context = { ...ctx, path },
        request = { ...req({ reasoning_effort: effort }), model };
      const output = plugin.convertRequest(context, request);
      assert.deepEqual(output.body.additionalModelRequestFields, {
        reasoning: { effort: want },
      });
      const response = runStream(plugin, context, request, [
        ev("assistantResponseEvent", { content: "answer" }),
        ev("metadataEvent", {
          tokenUsage: {
            uncachedInputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 20,
            cacheWriteInputTokens: 3,
          },
        }),
      ]);
      assert.equal(
        response.body.usage.prompt_tokens_details.cache_write_tokens,
        3,
      );
    }
});
test("native Chat history carries tool results, images and developer instructions", () => {
  const output = plugin.convertRequest(
    { ...ctx, path: "/v1/chat/completions" },
    req({
      messages: [
        { role: "developer", content: "rules" },
        { role: "user", content: "read" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "t",
              type: "function",
              function: { name: "read", arguments: '{"path":"f"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "t", content: "ok" },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YQ==" },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: { type: "object" } },
        },
      ],
    }),
  );
  const state = output.body.conversationState;
  assert.equal(state.history[0].userInputMessage.content, "rules");
  assert.deepEqual(
    state.history[3].assistantResponseMessage.toolUses[0].input,
    { path: "f" },
  );
  assert.equal(
    state.currentMessage.userInputMessage.userInputMessageContext.toolResults[0]
      .content[0].text,
    "ok",
  );
  assert.equal(
    state.currentMessage.userInputMessage.images[0].source.bytes,
    "YQ==",
  );
});

test("AWS errors without an Exception suffix fail before stream output", () => {
  for (const code of [
    "InternalFailure",
    "AccessDenied",
    "ServiceUnavailable",
    "Throttling",
  ]) {
    const output = runStream(plugin, ctx, req({}, true), [
      ev(code, { message: "fixture-secret" }),
    ]);
    assert.equal(output.error?.status, 502, code);
    assert.deepEqual(output.events, []);
    assert.doesNotMatch(output.error.message, /fixture-secret/);
  }
});
test("empty or metadata-only generation fails, hidden reasoning-only is still valid", () => {
  for (const events of [
    [],
    [ev("metadataEvent", { tokenUsage: { outputTokens: 0 } })],
  ])
    assert.equal(runStream(plugin, ctx, req(), events).error?.status, 502);
  assert.equal(
    runStream(plugin, ctx, req(), [
      ev("reasoningContentEvent", { text: "hidden" }),
    ]).body.stop_reason,
    "end_turn",
  );
});
test("a reused history tool ID cannot keep a later unanswered call", () => {
  const output = plugin.convertRequest(
    ctx,
    req({
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "same", name: "read", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "same", content: "done" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "same", name: "write", input: {} }],
        },
        { role: "user", content: "next" },
      ],
    }),
  );
  const history = output.body.conversationState.history;
  assert.equal(history[1].assistantResponseMessage.toolUses.length, 1);
  assert.equal(history[3].assistantResponseMessage.toolUses.length, 0);
});
test("partial usage preserves estimates for unreported counts and rejects non-objects", () => {
  const events = [
    ev("assistantResponseEvent", { content: "12345678" }),
    ev("metadataEvent", { tokenUsage: { uncachedInputTokens: 10 } }),
  ];
  assert.equal(
    runStream(plugin, ctx, req(), events).body.usage.output_tokens,
    2,
  );
  for (const tokenUsage of ["bad", [], 42])
    assert.ok(
      runStream(plugin, ctx, req(), [ev("metadataEvent", { tokenUsage })])
        .error,
    );
});

test("tool schemas are normalized without changing client data", () => {
  const input = {
    properties: null,
    required: ["path", 42],
    additionalProperties: null,
  };
  const output = plugin.convertRequest(
    ctx,
    req({ tools: [{ name: "read", input_schema: input }] }),
  );
  assert.deepEqual(
    output.body.conversationState.currentMessage.userInputMessage
      .userInputMessageContext.tools[0].toolSpecification.inputSchema.json,
    {
      type: "object",
      properties: {},
      required: ["path"],
      additionalProperties: true,
    },
  );
  assert.equal(input.properties, null);
});
test("Claude Code session IDs remain stable across requests", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  for (const user_id of [
    "user_session_" + id,
    JSON.stringify({ session_id: id }),
  ])
    assert.equal(
      plugin.convertRequest(ctx, req({ metadata: { user_id } })).body
        .conversationState.conversationId,
      id,
    );
});
test("inherited tool names and oversized usage cannot escape validation", () => {
  const output = runStream(plugin, ctx, req(), [
    ev("toolUseEvent", {
      toolUseId: "id",
      name: "toString",
      input: "{}",
      stop: true,
    }),
  ]);
  assert.equal(output.body.content[0].name, "toString");
  assert.ok(
    runStream(plugin, ctx, req(), [
      ev("metadataEvent", { tokenUsage: { outputTokens: 1e30 } }),
    ]).error,
  );
});

test("request uses native Grok effort without duplicated thinking prompt", () => {
  const output = plugin.convertRequest(ctx, {
    ...req({ thinking: { type: "enabled" }, output_config: { effort: "max" } }),
    model: "grok-4.7",
  });
  assert.deepEqual(output.body.additionalModelRequestFields, {
    reasoning: { effort: "xhigh" },
  });
  assert.equal(output.body.conversationState.history, undefined);
  assert.equal(output.state.thinking, true);
  assert.equal(output.stream, true);
});
test("disabled thinking wins over model suffix and output effort", () => {
  const output = plugin.convertRequest(ctx, {
    ...req({
      thinking: { type: "disabled" },
      output_config: { effort: "high" },
    }),
    model: "grok-4.7-thinking",
  });
  assert.equal(output.body.additionalModelRequestFields, undefined);
  assert.equal(output.state.thinking, false);
});
test("legacy prompt and Opus 4.6 adaptive exceptions", () => {
  const legacy = plugin.convertRequest(ctx, {
    ...req({ thinking: { type: "enabled", budget_tokens: 999999 } }),
    model: "claude-sonnet-4.5",
  });
  assert.match(
    legacy.body.conversationState.history[0].userInputMessage.content,
    /<max_thinking_length>24576</,
  );
  const enabled = plugin.convertRequest(ctx, {
    ...req({ thinking: { type: "enabled" } }),
    model: "claude-opus-4.6",
  });
  assert.equal(enabled.body.additionalModelRequestFields, undefined);
  const adaptive = plugin.convertRequest(ctx, {
    ...req({
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
    }),
    model: "claude-opus-4.6",
  });
  assert.deepEqual(adaptive.body.additionalModelRequestFields, {
    output_config: { effort: "high" },
  });
});
test("history reasoning accepts one valid union and rejects unsafe combinations", () => {
  const valid = {
    type: "thinking",
    thinking: "private",
    signature: "authentic-signature",
  };
  assert.deepEqual(historyReasoning([valid]), {
    reasoningText: { text: "private", signature: "authentic-signature" },
  });
  for (const content of [
    [valid, valid],
    [{ ...valid, signature: "" }],
    [{ ...valid, signature: "kiro-rs-thinking-signature" }],
    [{ type: "redacted_thinking", data: "ab==" }],
  ])
    assert.equal(historyReasoning(content), undefined);
  assert.deepEqual(
    historyReasoning([{ type: "redacted_thinking", data: "YQ==" }]),
    { redactedContent: "YQ==" },
  );
});
test("signature rejection retries once, preserving current body and stripping reasoning only", () => {
  const request = req({
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "next" },
    ],
  });
  const initial = plugin.convertRequest(ctx, request),
    failure = {
      status: 400,
      body: JSON.stringify({ reason: "THINKING_SIGNATURE_INVALID" }),
    };
  const output = plugin.convertResponse(
    { ...ctx, state: initial.state },
    failure,
  );
  const old = initial.body.conversationState,
    newState = output.next.body.conversationState;
  assert.equal(
    newState.history[1].assistantResponseMessage.reasoningContent,
    undefined,
  );
  assert.equal(newState.history[1].assistantResponseMessage.content, "answer");
  assert.deepEqual(newState.currentMessage, old.currentMessage);
  assert.ok(old.history[1].assistantResponseMessage.reasoningContent);
  assert.ok(
    plugin.convertResponse({ ...ctx, state: output.state }, failure).error,
  );
  assert.ok(
    plugin.convertResponse(
      { ...ctx, state: initial.state },
      { status: 400, body: "signature invalid" },
    ).error,
  );
});
test("tool pairing repairs orphans, restores long names and keeps signed reasoning", () => {
  const name = "测试".repeat(30);
  const output = plugin.convertRequest(
    ctx,
    req({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan", signature: "s" },
            { type: "tool_use", id: "t", name, input: { x: 1 } },
            { type: "tool_use", id: "orphan", name: "unused", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t", content: "ok" },
            { type: "tool_result", tool_use_id: "bad", content: "bad" },
          ],
        },
      ],
    }),
  );
  const state = output.body.conversationState,
    assistant = state.history[1].assistantResponseMessage,
    tool = assistant.toolUses[0];
  assert.equal(assistant.toolUses.length, 1);
  assert.ok(assistant.reasoningContent);
  assert.ok(Buffer.byteLength(tool.name) <= 63);
  assert.equal(output.state.names[tool.name], name);
  assert.equal(
    state.currentMessage.userInputMessage.userInputMessageContext.toolResults
      .length,
    1,
  );
  assert.equal(
    state.currentMessage.userInputMessage.userInputMessageContext.tools[0]
      .toolSpecification.name,
    tool.name,
  );
});
test("tool names cannot poison maps or inherited property lookup", () => {
  const output = plugin.convertRequest(
    ctx,
    req({ tools: [{ name: "__proto__" }, { name: "constructor" }] }),
  );
  assert.equal(output.state.names.__proto__, "__proto__");
});
test("prefill trimmed, user turns merged, system prefix retained", () => {
  const output = plugin.convertRequest(
    ctx,
    req({
      system: "rules",
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "prefill" },
      ],
    }),
  );
  assert.equal(
    output.body.conversationState.currentMessage.userInputMessage.content,
    "a\nb",
  );
  assert.equal(
    output.body.conversationState.history[0].userInputMessage.content,
    "rules",
  );
});
test("API keys omit profile; channel profile is validated", () => {
  assert.equal(
    plugin.convertRequest(
      { ...ctx, config: { credentialType: "api_key" } },
      req(),
    ).body.profileArn,
    undefined,
  );
  assert.throws(
    () =>
      plugin.convertRequest(
        { ...ctx, config: { profileArn: "garbage" } },
        req(),
      ),
    /Profile ARN/,
  );
});
test("images stay inline and malformed sources fail visibly", () => {
  const content = [
    { type: "image", source: { media_type: "image/png", data: "YQ==" } },
  ];
  assert.equal(
    plugin.convertRequest(ctx, req({ messages: [{ role: "user", content }] }))
      .body.conversationState.currentMessage.userInputMessage.images[0].source
      .bytes,
    "YQ==",
  );
  assert.throws(
    () =>
      plugin.convertRequest(
        ctx,
        req({
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { url: "https://example.com/img" } },
              ],
            },
          ],
        }),
      ),
    /inline base64/,
  );
});
test("Responses route accepts host Chat request and returns Chat for host conversion", () => {
  const responseCtx = { ...ctx, path: "/v1/responses" };
  const output = runStream(
    plugin,
    responseCtx,
    req({
      messages: [
        { role: "developer", content: "system" },
        { role: "user", content: "hello" },
      ],
    }),
    [ev("assistantResponseEvent", { content: "Hello" })],
  );
  assert.equal(output.body.object, "chat.completion");
  assert.equal(output.body.choices[0].message.content, "Hello");
});
test("all three client routes support streaming and nonstreaming contracts", () => {
  for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses"])
    for (const stream of [false, true]) {
      const output = runStream(plugin, { ...ctx, path }, req({}, stream), [
        ev("assistantResponseEvent", { content: "answer" }),
      ]);
      assert.equal(output.error, undefined);
      if (stream)
        assert.ok(
          output.events.some(
            (e) => e.data === "[DONE]" || e.event === "message_stop",
          ),
        );
      else
        assert.equal(
          path !== "/v1/messages"
            ? output.body.choices[0].message.content
            : output.body.content[0].text,
          "answer",
        );
    }
});
test("stream block starts are empty, deltas reconstruct text exactly once", () => {
  const output = runStream(plugin, ctx, req({}, true), [
    ev("assistantResponseEvent", { content: "hello" }),
    ev("assistantResponseEvent", { content: " world" }),
  ]);
  assert.equal(
    output.events.find((e) => e.event === "content_block_start").data
      .content_block.text,
    "",
  );
  assert.equal(
    output.events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join(""),
    "hello world",
  );
  assert.equal(output.events[0].event, "message_start");
});
test("disabled native thinking never leaks, including thinking-only answers", () => {
  for (const stream of [false, true]) {
    const output = runStream(
      plugin,
      ctx,
      req({ thinking: { type: "disabled" } }, stream),
      [ev("reasoningContentEvent", { text: "SECRET", signature: "sig" })],
    );
    assert.doesNotMatch(
      JSON.stringify(output.body || output.events),
      /SECRET|sig/,
    );
    if (!stream) {
      assert.deepEqual(output.body.content, []);
      assert.equal(output.body.stop_reason, "end_turn");
    }
  }
});
test("native reasoning preserves signatures and separates visible output", () => {
  const output = runStream(
    plugin,
    ctx,
    req({ thinking: { type: "enabled" } }),
    [
      ev("reasoningContentEvent", { text: "plan", signature: "sig" }),
      ev("assistantResponseEvent", { content: "answer" }),
    ],
  );
  assert.deepEqual(output.body.content, [
    { type: "thinking", thinking: "plan", signature: "sig" },
    { type: "text", text: "answer" },
  ]);
});
test("legacy parser handles split tags without stripping quoted tags", () => {
  const output = runStream(
    plugin,
    ctx,
    req({ thinking: { type: "enabled" } }),
    ["<thi", "nking>\nplan</think", "ing>\n\nanswer `<thinking>`"].map(
      (content) => ev("assistantResponseEvent", { content }),
    ),
  );
  assert.deepEqual(output.body.content, [
    { type: "thinking", thinking: "plan", signature: "" },
    { type: "text", text: "answer `<thinking>`" },
  ]);
});
test("interleaved tools remain serial and late names preserve arguments", () => {
  const events = [
    ev("toolUseEvent", { toolUseId: "a", input: '{"x":' }),
    ev("toolUseEvent", {
      toolUseId: "b",
      name: "second",
      input: "{}",
      stop: true,
    }),
    ev("assistantResponseEvent", { content: "after" }),
    ev("toolUseEvent", {
      toolUseId: "a",
      name: "first",
      input: "1}",
      stop: true,
    }),
  ];
  const result = runStream(plugin, ctx, req({}, true), events);
  assert.equal(result.error, undefined);
  const starts = result.events.filter((e) => e.event === "content_block_start");
  assert.deepEqual(
    starts.map((e) => e.data.content_block.type),
    ["tool_use", "tool_use", "text"],
  );
  assert.deepEqual(
    result.state.content
      .filter((b) => b.type === "tool_use")
      .map((b) => [b.id, b.name, b.input]),
    [
      ["a", "first", { x: 1 }],
      ["b", "second", {}],
    ],
  );
  let open = false;
  for (const e of result.events) {
    if (e.event === "content_block_start") {
      assert.equal(open, false);
      open = true;
    }
    if (e.event === "content_block_stop") {
      assert.equal(open, true);
      open = false;
    }
  }
});
test("tool truncation, non-object JSON and changed names fail without leaking arguments", () => {
  for (const events of [
    [
      ev("toolUseEvent", {
        toolUseId: "a",
        name: "first",
        input: '{"SECRET":',
      }),
    ],
    [
      ev("toolUseEvent", {
        toolUseId: "a",
        name: "first",
        input: "[]",
        stop: true,
      }),
    ],
    [
      ev("toolUseEvent", { toolUseId: "a", name: "first", input: "{}" }),
      ev("toolUseEvent", { toolUseId: "a", name: "second", stop: true }),
    ],
  ]) {
    const output = runStream(plugin, ctx, req(), events);
    assert.equal(output.error.status, 502);
    assert.doesNotMatch(output.error.message, /SECRET/);
  }
});
test("empty no-argument tool completes at EOF; refusal never returns executable tools", () => {
  assert.deepEqual(
    runStream(plugin, ctx, req(), [
      ev("toolUseEvent", { toolUseId: "t", name: "noop" }),
    ]).body.content[0].input,
    {},
  );
  assert.ok(
    runStream(plugin, ctx, req(), [
      ev("toolUseEvent", { toolUseId: "t", name: "noop" }),
      ev("metadataEvent", { stopReason: "CONTENT_FILTERED" }),
    ]).error,
  );
});
test("authoritative token usage preserves cache fields and zero values", () => {
  const events = [
    ev("assistantResponseEvent", { content: "Hello" }),
    ev("metadataEvent", {
      tokenUsage: {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 100,
        cacheWriteInputTokens: 30,
      },
      stopReason: "MAX_TOKENS",
    }),
  ];
  const claude = runStream(plugin, ctx, req(), events).body;
  assert.deepEqual(claude.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 30,
  });
  assert.equal(claude.stop_reason, "max_tokens");
  const chat = runStream(
    plugin,
    { ...ctx, path: "/v1/responses" },
    req(),
    events,
  ).body;
  assert.equal(chat.usage.prompt_tokens, 130);
  assert.equal(chat.usage.total_tokens, 130);
});
test("fallback output estimate is independent of fragment boundaries", () => {
  const text = "中abcd文efgh";
  const a = runStream(plugin, ctx, req(), [
    ev("assistantResponseEvent", { content: text }),
  ]);
  const b = runStream(
    plugin,
    ctx,
    req(),
    Array.from(text).map((content) =>
      ev("assistantResponseEvent", { content }),
    ),
  );
  assert.deepEqual(a.body.usage, b.body.usage);
});
test("native stop reason wins over context percentage; stream exceptions are sanitized", () => {
  assert.equal(
    runStream(plugin, ctx, req(), [
      ev("contextUsageEvent", { contextUsagePercentage: 100 }),
      ev("metadataEvent", { stopReason: "END_TURN" }),
    ]).body.stop_reason,
    "end_turn",
  );
  const output = runStream(plugin, ctx, req(), [
    ev("InternalServerException", { message: "secret-token" }),
  ]);
  assert.ok(output.error);
  assert.doesNotMatch(output.error.message, /secret-token/);
});
test("request state is isolated across interleaved accounts", () => {
  const a = plugin.convertRequest(ctx, req()).state,
    b = plugin.convertRequest(ctx, req()).state;
  const next = plugin.convertStreamEvent(
    { ...ctx, state: a },
    ev("assistantResponseEvent", { content: "account A" }),
  );
  const bEnd = plugin.convertStreamEvent({ ...ctx, state: b }, { done: true });
  assert.equal(bEnd.error.status, 502);
  assert.equal(a.content, undefined);
  assert.equal(next.state.content[0].text, "account A");
});
