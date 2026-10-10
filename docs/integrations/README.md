# Connect an existing AI application

Run [clientd](../sdk/clientd-quickstart.md) on the user's computer and give the
application its local inference token. Keep the management token, wallet and
custody passphrase outside the application. Choose a model/API and mode from the
reviewed deployment configuration; changing an application's URL does not add a
provider, tariff or model to that deployment.

| Application | Guide | Recorded compatibility |
|---|---|---|
| OpenClaw | [Setup and recovery](openclaw.md) | Selected public OpenRouter text, streaming and read-tool cases passed with the [settlement adapter](openclaw-settlement-adapter.md). [Public evidence](../evidence/PD-native-public-N02-N03.md). |
| Claude Code | [Gateway configuration and compatibility](claude-code.md) | Configuration is documented. The tested CLI sends a query and request fields rejected by clientd/proxy. Not ready for funded use. |
| Codex CLI | [Responses provider configuration and compatibility](codex.md) | Configuration is documented. The tested CLI sends fields/tools rejected by direct Responses validation. Not ready for funded use. |

An API route existing is not a client compatibility result. Actual client
versions, automatic retries, tool continuations and failure handling must be
tested together. In particular, OpenClaw's OpenRouter Chat result does not verify
Claude Code's Anthropic Messages or Codex's OpenAI Responses integration.

The [coding-client compatibility evidence](../evidence/I10-coding-client-configuration.md)
records the isolated probes and remaining blockers. These probes use synthetic
responses and local credentials, with no provider or public-chain activity.

Normal Claude and ChatGPT chat interfaces are a separate integration surface.
An MCP tool can expose ZKAPI functionality after an adapter is implemented; that
does not replace the host application's primary model connection or billing.
No ZKAPI MCP adapter is included here.
