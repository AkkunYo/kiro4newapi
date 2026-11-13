import test from "node:test";
import assert from "node:assert/strict";
import * as plugin from "../src/plugin.js";
import { ctx, setup } from "./helpers.mjs";
setup();
const modelCtx = { ...ctx, path: "/v1/models" };
const response = (body) => ({ status: 200, body: JSON.stringify(body) });
test("live model pagination preserves 500K context and deduplicates IDs", () => {
  const page = plugin.convertResponse(
    modelCtx,
    response({
      models: [
        {
          modelId: "grok-4.7",
          tokenLimits: { maxInputTokens: 500000, maxOutputTokens: 32000 },
        },
      ],
      nextToken: "a/b",
    }),
  );
  assert.match(page.next.url, /nextToken=a%2Fb/);
  const output = plugin.convertResponse(
    { ...modelCtx, state: page.state },
    response({ models: [{ modelId: "gpt-5.6-sol" }] }),
  );
  assert.deepEqual(
    output.body.data.map((m) => m.id),
    ["grok-4.7", "gpt-5.6-sol"],
  );
  assert.equal(output.body.data[0].context_length, 500000);
  assert.ok(
    plugin.convertResponse(
      { ...modelCtx, state: page.state },
      response({ models: [], nextToken: "a/b" }),
    ).error,
  );
});
test("management fallback is bounded; bearer rejection never tries other regions", () => {
  const failure = { status: 403, body: "Forbidden" };
  const next = plugin.convertResponse(modelCtx, failure);
  assert.match(next.next.url, /q.eu-central-1/);
  assert.ok(
    plugin.convertResponse({ ...modelCtx, state: next.state }, failure).error,
  );
  const rejected = plugin.convertResponse(modelCtx, {
    status: 403,
    body: "The bearer token included in the request is invalid",
  });
  assert.equal(rejected.error.status, 401);
  assert.equal(rejected.next, undefined);
});
test("balance reports precise Credits, only active trials and bonuses, never invented currency", () => {
  const output = plugin.parseBalance(
    ctx,
    response({
      usageBreakdownList: [
        {
          displayName: "Kiro",
          currentUsageWithPrecision: 12.345,
          usageLimitWithPrecision: 500,
          nextDateReset: 1800500000.5,
          freeTrialInfo: {
            freeTrialStatus: "ACTIVE",
            currentUsageWithPrecision: 1,
            usageLimitWithPrecision: 50,
          },
          bonuses: [
            { status: "EXPIRED", currentUsage: 0, usageLimit: 1000 },
            {
              status: "ACTIVE",
              displayName: "Gift",
              currentUsage: 0,
              usageLimit: 20,
            },
          ],
        },
      ],
    }),
  );
  assert.equal(output.windows.length, 3);
  assert.equal(output.windows[0].used, 12.345);
  assert.equal(output.windows[0].resetAt, 1800500000);
  assert.equal(output.windows[0].unit, "Credit");
  assert.equal(output.currency, undefined);
  assert.equal(output.amount, undefined);
});
test("quota absence and authentication failure remain visible", () => {
  assert.ok(
    plugin.parseBalance(ctx, response({ usageBreakdownList: [] })).error,
  );
  const rejected = plugin.parseBalance(ctx, {
    status: 403,
    body: "The bearer token included in the request is invalid",
  });
  assert.match(rejected.error, /credentials/);
  assert.equal(rejected.next, undefined);
});
