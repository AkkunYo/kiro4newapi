// Injected into the pinned host's providerplugin package by test-host.sh.
package providerplugin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Exercises real host request conversion, AWS framing, plugin conversion,
// final client protocol conversion and token accounting. No network or DB.
func TestKiro4NewAPIRelay(t *testing.T) {
	source, err := os.ReadFile(os.Getenv("KIRO_PLUGIN_FILE"))
	require.NoError(t, err)
	plugin, err := jsplugin.CompilePlugin(string(source), jsplugin.Options{})
	require.NoError(t, err)
	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })
	config := plugin.ChannelConfigFor(json.RawMessage(`{"credentialType":"api_key"}`))
	for _, path := range []string{"/v1/messages", "/v1/chat/completions", "/v1/responses"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%v", path, stream), func(t *testing.T) {
				format := types.RelayFormatOpenAI
				if path == "/v1/messages" {
					format = types.RelayFormatClaude
				}
				if path == "/v1/responses" {
					format = types.RelayFormatOpenAIResponses
				}
				info := &relaycommon.RelayInfo{RelayFormat: format, RelayMode: relayconstant.RelayModeChatCompletions, RequestURLPath: path, OriginModelName: "grok-4.7", IsStream: stream, DisablePing: true, ShouldIncludeUsage: true, ClaudeConvertInfo: &relaycommon.ClaudeConvertInfo{LastMessagesType: relaycommon.LastMessageTypeNone}, ChannelMeta: &relaycommon.ChannelMeta{ApiKey: "fixture-key", ChannelType: constant.ChannelTypeTaskPlugin, ChannelBaseUrl: "https://q.us-east-1.amazonaws.com", UpstreamModelName: "grok-4.7", ChannelOtherSettings: dto.ChannelOtherSettings{AdvancedCustom: plugin.Meta.ChannelRelayConfig(config), PluginConfig: config}}}
				recorder := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(recorder)
				c.Request = httptest.NewRequest(http.MethodPost, path, nil)
				adaptor := &Adaptor{plugin: plugin, config: config}
				adaptor.Init(info)
				var converted any
				switch path {
				case "/v1/messages":
					var request dto.ClaudeRequest
					require.NoError(t, json.Unmarshal([]byte(`{"model":"grok-4.7","max_tokens":100,"messages":[{"role":"user","content":"hello"}],"thinking":{"type":"enabled","budget_tokens":20000}}`), &request))
					request.Stream = &stream
					converted, err = adaptor.ConvertClaudeRequest(c, info, &request)
				case "/v1/chat/completions":
					var request dto.GeneralOpenAIRequest
					require.NoError(t, json.Unmarshal([]byte(`{"model":"grok-4.7","messages":[{"role":"user","content":"hello"}],"reasoning_effort":"high"}`), &request))
					request.Stream = &stream
					converted, err = adaptor.ConvertOpenAIRequest(c, info, &request)
				case "/v1/responses":
					var request dto.OpenAIResponsesRequest
					require.NoError(t, json.Unmarshal([]byte(`{"model":"grok-4.7","input":"hello","reasoning":{"effort":"high"}}`), &request))
					request.Stream = &stream
					converted, err = adaptor.ConvertOpenAIResponsesRequest(c, info, request)
				}
				require.NoError(t, err)
				wire, err := json.Marshal(converted)
				require.NoError(t, err)
				hc := jsplugin.HookContext{BaseURL: info.ChannelBaseUrl, Path: path, Config: config}
				first, err := plugin.CallConvertRequest(context.Background(), hc, jsplugin.ConvertInput{Body: wire, Model: info.UpstreamModelName, Stream: stream})
				require.NoError(t, err)
				assert.Contains(t, string(first.Body), `"effort":"high"`, string(wire))
				var frames bytes.Buffer
				for _, event := range [][2]string{
					{"reasoningContentEvent", `{"text":"plan","signature":"fixture-signature"}`},
					{"assistantResponseEvent", `{"content":"answer"}`},
					{"toolUseEvent", `{"toolUseId":"a","name":"read","input":"{\"path\":"}`},
					{"toolUseEvent", `{"toolUseId":"b","name":"write","input":"{}","stop":true}`},
					{"toolUseEvent", `{"toolUseId":"a","input":"\"file.txt\"}","stop":true}`},
					{"metadataEvent", `{"tokenUsage":{"uncachedInputTokens":10,"outputTokens":7,"cacheReadInputTokens":20,"cacheWriteInputTokens":3},"stopReason":"TOOL_USE"}`},
				} {
					frames.Write(eventStreamMessage([][2]string{{":message-type", "event"}, {":event-type", event[0]}}, event[1]))
				}
				outcome, err := adaptor.readStep(c, info, &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {eventStreamContentType}}, Body: io.NopCloser(&frames)}, first, first.State, true)
				require.NoError(t, err)
				require.Equal(t, 200, outcome.response.StatusCode)
				usage, apiErr := adaptor.DoResponse(c, outcome.response, info)
				require.Nil(t, apiErr)
				body := recorder.Body.String()
				assert.Contains(t, body, "answer")
				assert.Contains(t, body, "read")
				assert.Contains(t, body, "write")
				assert.Contains(t, body, "file.txt")
				counts := usage.(*dto.Usage)
				// The host keeps Anthropic uncached input separately for billing;
				// OpenAI's prompt count includes cache reads and writes.
				prompt := 10
				if path != "/v1/messages" {
					prompt = 33
				}
				assert.Equal(t, prompt, counts.PromptTokens, body)
				details := &counts.PromptTokensDetails
				if path == "/v1/responses" {
					details = counts.InputTokensDetails
				}
				require.NotNil(t, details)
				assert.Equal(t, 20, details.CachedTokens, body)
				assert.Equal(t, 3, details.CacheCreationTokensTotal(), body)
				assert.Equal(t, 7, counts.CompletionTokens, body)
				if stream {
					marker := "[DONE]"
					if path == "/v1/messages" {
						marker = "message_stop"
					}
					if path == "/v1/responses" {
						marker = "response.completed"
					}
					assert.Contains(t, body, marker)
				} else {
					var decoded map[string]any
					require.NoError(t, json.Unmarshal([]byte(body), &decoded))
					if path == "/v1/messages" {
						assert.Equal(t, "message", decoded["type"])
					} else if path == "/v1/chat/completions" {
						assert.Equal(t, "chat.completion", decoded["object"])
					} else {
						assert.Equal(t, "response", decoded["object"])
					}
				}
			})
		}
	}
}
