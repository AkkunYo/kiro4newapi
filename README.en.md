# kiro4newapi

[中文](README.md)

A native Kiro provider plugin for New API. Upload one `plugin.js`; New API owns credentials, token refresh, routing and account scheduling. No separate CPA process is required.

Ported from [kiro4cpa-plugin](https://github.com/AkkunYo/kiro4cpa-plugin) at `1582a9c`, including applicable [kiro.rs v0.9.9](https://github.com/ZyphrZero/kiro.rs/releases/tag/v0.9.9) changes. Tested against **New API v1.0.0-rc.50 and rc.51**, pinned at `f2aa9123` and `c9c6da27`. Prefer rc.51, which fixes a host crash on some CPUs without AVX. Older hosts without Provider part support cannot load it.

## Install

1. Download `plugin.js` from [Releases](https://github.com/AkkunYo/kiro4newapi/releases). ZIP packages include documentation; verify with `SHA256SUMS`.
2. Upload and enable it on New API's plugin page (`/task-plugins`). Name: **Kiro**; key: `akkunyo-kiro`.
3. Create a plugin channel (type 61) bound to it. Base URL: `https://q.us-east-1.amazonaws.com`, or `https://q.eu-central-1.amazonaws.com` for Europe. Do not append `/v1`.
4. Configure credentials, save the channel and sign in, or paste an API key. Fetch the live model list and configure model access, groups and pricing.
5. Clients use your New API URL and token. Kiro credentials stay on the gateway.

Upload the bundled root `plugin.js`, not individual files in `src/`. Kiro Credit windows do not determine what your gateway charges clients; the plugin does not configure prices.

## Credentials

`credentialType`: `social`, `builder-id`, `iam`, or `api_key`. `loginMode`: `browser` or `import`. `authRegion` defaults to `us-east-1`, independently of the inference Base URL. Optional settings: `profileArn`, IAM `startUrl`, and `clientVersion` (default `1.4.5`).

- **Google/GitHub:** select `social` + `browser`, then Sign in. Open the authorization link in the field description. After authorization, copy the **entire** `http://127.0.0.1:3128/oauth/callback?...` or `/signin/callback?...` address into the form, even if the page fails to load. Keep the exact path, state and login_option. The plugin verifies state and uses the host-held PKCE verifier. Avoid another local service using port 3128 during login.
- **Builder ID/IAM:** select the type and auth region, then complete device authorization. IAM also requires `https://<directory>.awsapps.com/start` in `startUrl`.
- **Import:** select the matching type and `import`, then paste credential JSON in the login form. Social needs `refreshToken`; Builder ID/IAM also need `clientId` and `clientSecret`. Existing CPA `authMethod: "idc"` / `idcRegion` fields are accepted. The plugin refreshes immediately to validate the credentials.
- **API key:** select `api_key` and paste a single Kiro API key in the channel key field. Do not use Sign in. Requests use `tokentype: API_KEY` without a profile ARN.

All accounts in a channel must use the same credential type and profile requirements. The host hides account credentials from request conversion, and signing cannot modify the body, so per-account ARNs cannot automatically reach inference. Set the real ARN in the channel's `profileArn`; split accounts with different ARNs into separate channels. Without it, inference uses CPA's compatible Social/IDC fallback ARN. Model/quota requests start without an ARN and can try the configured ARN and alternate regions.

## Capabilities and limits

- Streaming and nonstreaming `/v1/messages`, `/v1/chat/completions`, and `/v1/responses`. Chat Completions is converted directly to preserve explicit reasoning effort; Responses uses the host Chat conversion chain.
- Tool-history pairing and schema normalization, long-name restoration, interleaved argument collection. Tool arguments are emitted only when complete and valid JSON objects.
- Inline base64 JPEG/PNG/GIF/WebP images. Remote image downloads are unsupported.
- Native reasoning, legacy thinking tags, Grok effort normalization, signed reasoning history safeguards and one retry for explicit `THINKING_SIGNATURE_INVALID`. Disabled thinking never becomes visible answer text. OpenAI conversion chains do not guarantee signature preservation.
- Live model pagination with upstream context limits; access remains subject to the account's upstream permissions. Credit windows show monthly, ACTIVE trial and ACTIVE bonus usage without inventing a USD balance. Upstream token/cache counts take precedence over estimates.
- `max_tokens`, temperature, top_p, top_k, stop_sequences, tool_choice and structured-output constraints are not enforced by this Kiro protocol. Trailing assistant prefill is removed. Responses storage/background tasks and multimodal extensions are not implemented by this plugin.
- Response state is limited to approximately 4 MiB characters and 128 tool calls. Truncated, malformed or oversized tool responses fail explicitly.
- rc.50/rc.51 management requests refresh automatically on 401 only. A Kiro 403 bearer-token rejection during model/quota queries remains a visible authentication error until the host refreshes, a normal inference request triggers refresh, or you sign in again. Inference recognizes this 403 via `credentialRejected`.
- CPA's UI, RPC process, cooling scheduler, and external_idp/Azure Entra login are not included. New API owns account persistence, scheduling, rate limits and refresh locking.

**Validation uses synthetic upstream responses and the actual New API runtime. No real Kiro credentials, login, generation, or signature acceptance were tested.** Kiro's private interface can change.

## Development

```sh
npm ci
npm run check
new-api plugin lint plugin.js
new-api plugin test plugin.js --fixture test/host-fixture.json
bash scripts/test-host.sh /path/to/new-api-v1.0.0-rc.50
```

Node 22+ is required only for development. esbuild bundles a synchronous ES module with no npm runtime dependencies. It uses no Node APIs, global fetch, environment variables or shared account state.

The host test script temporarily adds two test files and removes them on exit. CI runs Node tests on Linux/macOS/Windows and actual MoeJS/provider contracts plus host request conversion, AWS framing, client response conversion and usage tests on Linux against both pinned host versions. Test credentials are placeholders; no Kiro network calls are made.

MIT; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). New API server code is not bundled and retains its own license.

## Review record

Checked 2026-11-15: the reference default branch still equals kiro.rs v0.9.9 (`7dfb2c21dea5d2fa3618fdd603279d7fcef89074`), so no new upstream logic needs importing. Port fixes cover explicit Chat effort loss, missing native GPT `none`, missing cache-write counts, partial usage incorrectly treated as zero, mismatched IDC imports, AWS errors/empty streams reported as success, and unanswered calls surviving reused tool IDs. Tests now cover the full host conversion chain; live-account and host limitations above remain. The local CodeGraph index is excluded by `.codegraph/` in `.gitignore`.
