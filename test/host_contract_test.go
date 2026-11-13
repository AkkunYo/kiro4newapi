// Copied into the pinned New API source's pkg/jsplugin by scripts/test-host.sh.
// It exercises the actual MoeJS runtime and typed host result decoders.
package jsplugin

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKiro4NewAPIContracts(t *testing.T) {
	source, err := os.ReadFile(os.Getenv("KIRO_PLUGIN_FILE"))
	require.NoError(t, err)
	plugin, err := CompilePlugin(string(source), Options{Now: func() time.Time { return time.Unix(1800000000, 0) }})
	require.NoError(t, err)
	base := "https://q.us-east-1.amazonaws.com"
	config := json.RawMessage(`{"credentialType":"social"}`)

	t.Run("login_and_refresh", func(t *testing.T) {
		var requests []FetchRequest
		ctx := WithFetcher(context.Background(), func(_ context.Context, r FetchRequest) (FetchResponse, error) {
			requests = append(requests, r)
			return FetchResponse{Status: 200, Headers: map[string]string{"Content-Type": "application/json"}, Body: []byte(`{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresIn":1200}`)}, nil
		})
		login := LoginContext{State: "state", CodeVerifier: "verifier", CodeChallenge: "challenge", Config: config}
		step, err := plugin.CallLogin(ctx, base, login, nil, nil)
		require.NoError(t, err)
		require.Equal(t, LoginStepFields, step.Type)
		require.Len(t, step.Fields, 1)
		login.Session = step.Session
		step, err = plugin.CallLogin(ctx, base, login, nil, map[string]any{"fields": map[string]string{"callbackUrl": "http://127.0.0.1:3128/oauth/callback?state=state&code=fixture-code&login_option=github"}})
		require.NoError(t, err)
		require.Equal(t, LoginStepDone, step.Type)
		require.Len(t, requests, 1)
		assert.JSONEq(t, `{"code":"fixture-code","code_verifier":"verifier","redirect_uri":"http://127.0.0.1:3128/oauth/callback?login_option=github"}`, requests[0].Body)
		cc := CredentialContext{BaseURL: base, Credential: step.Result.Credential, Config: config}
		refreshed, err := plugin.CallRefresh(ctx, cc)
		require.NoError(t, err)
		assert.Equal(t, step.Result.AccountID, refreshed.AccountID)
		signed, err := plugin.CallSignRequest(ctx, cc, "POST", base+"/generateAssistantResponse", nil, "")
		require.NoError(t, err)
		assert.Equal(t, "Bearer fixture-access", signed.Headers["Authorization"])
	})

	for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
		for _, streaming := range []bool{false, true} {
			name := path + "/json"
			if streaming {
				name = path + "/stream"
			}
			t.Run(name, func(t *testing.T) {
				ctx := context.Background()
				hc := HookContext{BaseURL: base, Path: path, Config: config}
				converted, err := plugin.CallConvertRequest(ctx, hc, ConvertInput{Body: []byte(`{"messages":[{"role":"user","content":"hello"}],"thinking":{"type":"enabled"}}`), Model: "grok-4.7", Stream: streaming})
				require.NoError(t, err)
				hc.State = converted.State
				events := []StreamEvent{
					{Event: "reasoningContentEvent", Data: `{"text":"plan","signature":"fixture-signature"}`},
					{Event: "assistantResponseEvent", Data: `{"content":"answer"}`},
					{Event: "toolUseEvent", Data: `{"toolUseId":"a","name":"first","input":"{\"x\":"}`},
					{Event: "toolUseEvent", Data: `{"toolUseId":"b","name":"second","input":"{}","stop":true}`},
					{Event: "toolUseEvent", Data: `{"toolUseId":"a","input":"1}","stop":true}`},
					{Event: "metadataEvent", Data: `{"tokenUsage":{"uncachedInputTokens":10,"outputTokens":7,"cacheReadInputTokens":20,"cacheWriteInputTokens":3}}`},
				}
				var count int
				for _, event := range events {
					result, state, upstreamErr, err := plugin.CallConvertStreamEvent(ctx, hc, &event, false)
					require.NoError(t, err)
					require.Nil(t, upstreamErr)
					count += len(result.Events)
					hc.State = state
				}
				result, _, upstreamErr, err := plugin.CallConvertStreamEvent(ctx, hc, nil, true)
				require.NoError(t, err)
				require.Nil(t, upstreamErr)
				if streaming {
					assert.Positive(t, count)
					assert.NotEmpty(t, result.Events)
				} else {
					assert.Contains(t, string(result.Body), "answer")
					assert.Contains(t, string(result.Body), "first")
				}
			})
		}
	}
	t.Run("models_and_balance", func(t *testing.T) {
		ctx := context.Background()
		hc := HookContext{BaseURL: base, Path: "/v1/models", Config: config}
		models, upstreamErr, err := plugin.CallConvertResponse(ctx, hc, 200, nil, []byte(`{"models":[{"modelId":"grok-4.7","tokenLimits":{"maxInputTokens":500000}}]}`))
		require.NoError(t, err)
		require.Nil(t, upstreamErr)
		assert.Contains(t, string(models.Body), "500000")
		cc := CredentialContext{BaseURL: base, Config: config}
		request, err := plugin.CallBuildBalanceRequest(ctx, cc)
		require.NoError(t, err)
		result, err := plugin.CallParseBalance(ctx, cc, request.State, UpstreamResponse{Status: 200, Body: []byte(`{"usageBreakdownList":[{"currentUsageWithPrecision":1.25,"usageLimitWithPrecision":500}]}`)})
		require.NoError(t, err)
		require.NotNil(t, result.Balance)
		require.Len(t, result.Balance.Windows, 1)
		assert.Equal(t, "Credit", result.Balance.Windows[0].Unit)
	})
}
