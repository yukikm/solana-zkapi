# Configure Claude Desktop

**Claude Desktop is not yet usable with ZKAPI for real Chat requests.** Version
2.31226.1 accepted gateway settings and a synthetic connection test, but its
actual Chat request was rejected by clientd. Do not fund a note for this setup.
Use [OpenClaw](openclaw.md) for the documented agent path.

## Prepare gateway settings

These settings are for an isolated compatibility evaluation. They require a
deployment that supports **Anthropic Messages in explicit proxy mode**. The
public Devnet profile uses OpenRouter Chat Completions and cannot serve this API.

1. Open **Help → Troubleshooting → Enable Developer Mode**, then
   **Developer → Configure Third-Party Inference**.
2. Create a separate configuration and enter the values below.
3. Disable model discovery and enter the operator's exact model ID manually.
4. Enable **Chat** under Features. Keep Cowork and Code disabled for evaluation.
5. Export the configuration for review. **Apply Changes** activates it and
   restarts the application; it does not resolve the compatibility limit.

| Field | Value |
|---|---|
| Inference provider | Gateway |
| Credential kind | Static API key or a reviewed credential helper |
| Gateway auth scheme | Bearer |
| Gateway base URL | `http://127.0.0.1:8787` without `/v1` |
| Gateway API key | The clientd profile's `inference-token` |
| Model | An exact Anthropic Messages model from the deployment |

Run Desktop and [clientd](clientd.md) on the same computer. Keep the management
token, wallet and data password outside Desktop. Proxy mode lets the operator
read prompts and responses.

The [official configuration guide](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)
describes the UI; the [gateway guide](https://claude.com/docs/third-party/claude-desktop/gateway)
describes the Messages requirement and credentials.

## Why Chat does not work yet

The tested Desktop build sends a model-discovery `limit` query and a Chat
`beta` query. clientd rejects both with `unsupported_route`. Actual Chat also
sends metadata, thinking settings and beta headers outside the current proxy
contract. Its simpler connection test does not exercise that request format.

A connection test may itself send inference. Do not use a funded profile to
test these settings, remove validation guards or strip request fields to make
it pass. Current compatibility is summarized in [support](../support.md).
