import { createHash, randomUUID } from "node:crypto";
export const ctx = {
  baseUrl: "https://q.us-east-1.amazonaws.com",
  path: "/v1/messages",
  config: {},
};
export function setup(
  fetch = () => {
    throw new Error("Unexpected network access");
  },
) {
  globalThis.utils = {
    unixNow: () => 1800000000,
    uuid: randomUUID,
    sha256: (v) => createHash("sha256").update(v).digest("hex"),
    fetch,
  };
}
export const req = (body = {}, stream = false) => ({
  model: "claude-sonnet-4.6",
  stream,
  body: { messages: [{ role: "user", content: "hello" }], ...body },
});
export const ev = (event, data) => ({ event, data: JSON.stringify(data) });
export function runStream(plugin, context, request, events) {
  let state = plugin.convertRequest(context, request).state;
  const output = [];
  for (const input of [...events, { done: true }]) {
    const result = plugin.convertStreamEvent({ ...context, state }, input);
    if (result.error) return { error: result.error, events: output };
    state = result.state || state;
    output.push(...(result.events || []));
    if (result.body) return { body: result.body, events: output, state };
  }
  return { events: output, state };
}
