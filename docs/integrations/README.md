# AI application compatibility

Run [clientd](../getting-started/clientd.md) on the user's computer and give the
application its local inference token. Keep the management token, wallet and
custody passphrase outside the application. Choose a model/API and mode from the
reviewed deployment configuration; changing an application's URL does not add a
provider, tariff or model to that deployment.

| Application | Guide | Recorded compatibility |
|---|---|---|
| OpenClaw | [Setup and recovery](../getting-started/openclaw.md) | Selected public OpenRouter text, streaming and read-tool cases passed with the [settlement adapter](../getting-started/openclaw-settlement-adapter.md). [Public evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md). |
| Claude Desktop | [Desktop gateway setup](../getting-started/claude-desktop.md) | Official third-party inference settings are documented. The public OpenRouter Chat profile does not satisfy Desktop's Messages gateway contract; no Desktop lifecycle has been validated. |
| Claude Code | [Gateway configuration and compatibility](../getting-started/claude-code.md) | Configuration is documented. The tested CLI sends a query and request fields rejected by clientd/proxy. Not ready for funded use. |
| Codex CLI | [Responses provider configuration and compatibility](../getting-started/codex.md) | Configuration is documented. The tested CLI sends fields/tools rejected by direct Responses validation. Not ready for funded use. |

An API route existing is not a client compatibility result. Actual client
versions, automatic retries, tool continuations and failure handling must be
tested together. In particular, OpenClaw's OpenRouter Chat result does not verify
Claude Code's Anthropic Messages or Codex's OpenAI Responses integration.

The [coding-client compatibility evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-coding-client-configuration.md)
records the isolated probes and remaining blockers. These probes use synthetic
responses and local credentials, with no provider or public-chain activity.

Claude Desktop's third-party inference mode is a separate integration from
Claude Code's CLI settings; use its dedicated guide above. MCP tools are another
integration surface: an adapter could expose ZKAPI operations inside a host
conversation, but adding a tool does not itself replace the host's primary
model connection or billing. No ZKAPI MCP adapter is included here.
