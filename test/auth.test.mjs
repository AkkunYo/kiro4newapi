import test from "node:test";
import assert from "node:assert/strict";
import * as plugin from "../src/plugin.js";
import { parseCallback, machineId } from "../src/auth.js";
import { ctx, setup } from "./helpers.mjs";
const loginCtx = {
  ...ctx,
  login: {
    state: "state-123",
    codeVerifier: "pkce-verifier",
    codeChallenge: "pkce-challenge",
    session: null,
  },
};
const credential = {
  type: "social",
  authRegion: "us-east-1",
  refreshToken: "fixture-refresh",
  accessToken: "fixture-access",
};

test("social login binds PKCE/state and keeps complete redirect path", () => {
  const calls = [];
  setup((request) => {
    calls.push(request);
    return {
      status: 200,
      body: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresIn: 1200,
      },
    };
  });
  const start = plugin.login(loginCtx, null);
  assert.equal(start.type, "fields");
  assert.match(start.fields[0].description.en, /code_challenge=pkce-challenge/);
  assert.match(start.fields[0].description.en, /state=state-123/);
  const done = plugin.login(
    { ...loginCtx, login: { ...loginCtx.login, session: start.session } },
    {
      fields: {
        callbackUrl:
          "http://127.0.0.1:3128/signin/callback?code=code123&state=state-123&login_option=github",
      },
    },
  );
  assert.deepEqual(JSON.parse(calls[0].body), {
    code: "code123",
    redirect_uri: "http://127.0.0.1:3128/signin/callback?login_option=github",
    code_verifier: "pkce-verifier",
  });
  assert.equal(done.type, "done");
  assert.equal(done.expiresAt, 1800001200);
  assert.equal(done.credential.accountId, done.accountId);
});
test("callback rejects wrong state, duplicate params, remote host and missing path", () => {
  for (const url of [
    "http://127.0.0.1:3128/oauth/callback?code=c&state=wrong",
    "http://127.0.0.1:3128/oauth/callback?code=c&code=d&state=state-123",
    "https://attacker.example/oauth/callback?code=c&state=state-123",
    "http://127.0.0.1:3128/?code=c&state=state-123",
    "http://127.0.0.1:3128/oauth/callback?code=%XX&state=state-123",
  ])
    assert.throws(() => parseCallback(url, "state-123"));
});
test("refresh rotation preserves fingerprint and stable account identity", () => {
  const calls = [];
  setup((r) => {
    calls.push(r);
    return {
      status: 200,
      body: {
        accessToken: "new-access",
        refreshToken: "rotated-refresh",
        expiresIn: 200,
      },
    };
  });
  const before = {
    ...credential,
    machineId: "a".repeat(64),
    accountId: "stable-account",
  };
  const result = plugin.refresh({ ...ctx, credential: before });
  assert.equal(result.credential.machineId, before.machineId);
  assert.equal(result.accountId, "stable-account");
  assert.equal(result.credential.refreshToken, "rotated-refresh");
  assert.equal(before.refreshToken, "fixture-refresh");
  assert.deepEqual(JSON.parse(calls[0].body), {
    refreshToken: "fixture-refresh",
  });
});
test("omitted refresh token is preserved; transient errors do not require relogin", () => {
  setup(() => ({ status: 200, body: { accessToken: "access-only" } }));
  assert.equal(
    plugin.refresh({ ...ctx, credential }).credential.refreshToken,
    "fixture-refresh",
  );
  setup(() => ({ status: 503, body: { message: "SECRET" } }));
  assert.throws(
    () => plugin.refresh({ ...ctx, credential }),
    (e) => e.message.includes("503") && !e.message.includes("SECRET"),
  );
  setup(() => ({
    status: 400,
    body: { error: "invalid_grant", error_description: "SECRET" },
  }));
  assert.deepEqual(plugin.refresh({ ...ctx, credential }), { relogin: true });
});
test("credential import ignores supplied access token and verifies refresh credentials", () => {
  let calls = 0;
  setup(() => {
    calls++;
    return { status: 200, body: { accessToken: "validated" } };
  });
  const importCtx = { ...loginCtx, config: { loginMode: "import" } };
  assert.equal(plugin.login(importCtx, null).fields[0].type, "password");
  const done = plugin.login(importCtx, {
    fields: {
      credential: JSON.stringify({ ...credential, accessToken: "unverified" }),
    },
  });
  assert.equal(calls, 1);
  assert.equal(done.credential.accessToken, "validated");
  assert.throws(
    () =>
      plugin.login(importCtx, {
        fields: {
          credential: JSON.stringify({
            authMethod: "external_idp",
            refreshToken: "r",
          }),
        },
      }),
    /type/,
  );
});
test("Builder ID device flow keeps secrets in session and handles slow_down and expiry", () => {
  const calls = [];
  setup((r) => {
    calls.push(r);
    return calls.length === 1
      ? { status: 200, body: { clientId: "client", clientSecret: "secret" } }
      : {
          status: 200,
          body: {
            deviceCode: "device-secret",
            userCode: "USER",
            verificationUri: "https://view.awsapps.com/start",
            expiresIn: 600,
            interval: 5,
          },
        };
  });
  const context = { ...loginCtx, config: { credentialType: "builder-id" } };
  const step = plugin.login(context, null);
  assert.equal(step.type, "device");
  assert.equal(step.userCode, "USER");
  assert.equal(step.clientSecret, undefined);
  assert.equal(step.session.clientSecret, "secret");
  assert.equal(
    JSON.parse(calls[0].body).issuerUrl,
    "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
  );
  setup(() => ({ status: 400, body: { error: "slow_down" } }));
  const pending = plugin.login(
    { ...context, login: { ...context.login, session: step.session } },
    { poll: true },
  );
  assert.equal(pending.interval, 10);
  assert.equal(pending.session.interval, 10);
  setup(() => ({ status: 200, body: { accessToken: "a", refreshToken: "r" } }));
  const done = plugin.login(
    { ...context, login: { ...context.login, session: pending.session } },
    { poll: true },
  );
  assert.equal(done.type, "done");
  assert.equal(done.credential.clientSecret, "secret");
  assert.throws(
    () =>
      plugin.login(
        {
          ...context,
          login: {
            ...context.login,
            session: { ...step.session, expiresAt: 1 },
          },
        },
        { poll: true },
      ),
    /expired/,
  );
});
test("IAM requires trusted start URL and valid auth region before network access", () => {
  setup();
  for (const config of [
    { credentialType: "iam", startUrl: "http://evil/start" },
    { credentialType: "iam", startUrl: "https://evil.com/start" },
    { authRegion: "evil.com/path" },
  ])
    assert.throws(() => plugin.login({ ...loginCtx, config }, null));
});
test("existing CPA IDC spelling imports with region and OIDC refresh", () => {
  let call;
  setup((r) => {
    call = r;
    return { status: 200, body: { accessToken: "a" } };
  });
  const result = plugin.login(
    { ...loginCtx, config: { credentialType: "iam", loginMode: "import" } },
    {
      fields: {
        credential: JSON.stringify({
          type: "kiro4cpa",
          authMethod: "idc",
          idcRegion: "eu-west-1",
          refreshToken: "r",
          clientId: "id",
          clientSecret: "secret",
        }),
      },
    },
  );
  assert.equal(call.url, "https://oidc.eu-west-1.amazonaws.com/token");
  assert.equal(JSON.parse(call.body).grantType, "refresh_token");
  assert.equal(result.credential.type, "iam");
});
test("signing distinguishes API keys, includes stable fingerprint and rejects insecure base", () => {
  setup();
  const context = {
    ...ctx,
    config: { credentialType: "api_key" },
    apiKey: "fixture-api-key",
  };
  const a = plugin.signRequest(context),
    b = plugin.signRequest(context);
  assert.equal(a.headers.Authorization, "Bearer fixture-api-key");
  assert.equal(a.headers.tokentype, "API_KEY");
  assert.equal(a.headers["x-amz-user-agent"], b.headers["x-amz-user-agent"]);
  assert.notEqual(
    a.headers["amz-sdk-invocation-id"],
    b.headers["amz-sdk-invocation-id"],
  );
  assert.throws(
    () =>
      plugin.signRequest({
        ...context,
        baseUrl: "http://q.us-east-1.amazonaws.com",
      }),
    /HTTPS/,
  );
  assert.throws(
    () => plugin.signRequest({ ...context, apiKey: "key\r\ninjected: yes" }),
    /invalid/,
  );
  assert.equal(
    machineId({
      ...credential,
      machineId: "12345678-1234-1234-1234-123456789abc",
    }),
    "12345678123412341234123456789abc".repeat(2),
  );
});
test("403 bearer rejection is refreshable, unrelated 403 is not", () => {
  assert.equal(
    plugin.credentialRejected(ctx, {
      status: 403,
      body: "The bearer token included in the request is invalid",
    }),
    true,
  );
  assert.equal(
    plugin.credentialRejected(ctx, { status: 403, body: "Access denied" }),
    false,
  );
  assert.ok(plugin.checkKey(ctx, "random").error);
  assert.equal(
    plugin.checkKey(
      { ...ctx, config: { credentialType: "api_key" } },
      "fixture-key",
    ),
    undefined,
  );
});
