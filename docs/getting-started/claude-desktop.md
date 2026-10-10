# Configure Claude Desktop for Solana zkAPI

**Current result: the public Devnet profile cannot serve as a Claude Desktop
inference gateway.** It serves direct OpenRouter Chat; Desktop's gateway mode
requires Anthropic Messages. A separate, compatible Anthropic proxy deployment
and Desktop validation are prerequisites. Do not fund a note just to try the
settings below.

This guide covers the Claude Desktop application, including its Chat interface.
Official documentation checked **2026-10-10** confirms that Desktop's
third-party inference mode supports Chat, Cowork and Code through a compatible
gateway. The configuration procedure below is for evaluating such a deployment;
this repository has no verified Desktop end-to-end result.
See [Anthropic's Desktop on third-party overview](https://claude.com/docs/third-party/claude-desktop/overview).

## 1. Check the deployment before configuring Desktop

For an existing installation, start [clientd](clientd.md) with its original
profile and run these read-only commands, substituting its actual absolute path:

```sh
ZKAPI_PROFILE='/absolute/path/to/your-clientd-profile'
clientd request "$ZKAPI_PROFILE" status
clientd request "$ZKAPI_PROFILE" models
```

The [public revision-6 profile](public-devnet-preview.md) reports
`mode: "direct_openrouter"`. **Stop here for that profile.** An Anthropic model
name in its catalog still uses the Chat API; selecting that model does not add
Messages support. Existing funded profiles must retain their mode, pins and
custody. A new proxy deployment changes who can see prompts and responses and
must be selected explicitly.

For an operator-provided Anthropic proxy deployment, obtain its authenticated
profile, exact Claude model ID, tariff and request limits. Complete clientd setup
and read-only preflight, then compare the deployment against this contract:

| Desktop gateway requirement | clientd requirement and current limit |
|---|---|
| `POST /v1/messages`, streaming and tool use | `proxy` mode, provider `anthropic`, model policy containing `messages`, compatible tariff and request fields |
| Model discovery or explicit model list | `GET /v1/models` is available; Desktop discovery compatibility must be checked, or use exact IDs in Desktop's explicit model list |
| Gateway authentication | Local `inference-token` as `Authorization: Bearer ...`; clientd does not use an Anthropic account credential here |
| Supported request shape | No query strings; only supported text/client-tool fields and authenticated provider headers |
| Spending and recovery behavior | Bounded output, controlled request count, no automatic inference replay, verified settlement before new session work |

The endpoint and discovery requirements come from
[Anthropic's gateway contract](https://claude.com/docs/third-party/claude-desktop/gateway).
The mode/API restrictions are enforced by
[clientd model policy](../../packages/sdk/src/clientd-models.ts) and the
[HTTP frontend](../../apps/clientd/internal/daemon/server.go). The presence of
`/v1/messages` in the frontend is insufficient when the selected profile only
permits Chat.

## 2. Enter the Desktop gateway settings

Use a current Claude Desktop installation on a device where you can configure
third-party inference. The published clientd package requires Apple Silicon and
macOS 13.5+; Desktop's own platform availability does not extend clientd support.
On a managed device, an administrator's deployed configuration can make the
configuration form read-only.

For the compatible Anthropic proxy deployment described above:

1. Open **Help → Troubleshooting → Enable Developer Mode**.
2. Open **Developer → Configure Third-Party Inference…** and choose
   **Connection**.
3. Enter the following values. This table assumes clientd runs on the same Mac
   at its default port; remote or SSH sessions cannot reach that Mac through
   their own loopback address.

| Field | Value for the local clientd evaluation |
|---|---|
| Inference provider | **Gateway** |
| Gateway base URL | `http://127.0.0.1:8787` — no `/v1` suffix |
| Credential kind | **Static API key** |
| Gateway API key | Contents of this profile's private `inference-token` file |
| Gateway auth scheme | **Bearer** |
| Models / `inferenceModels` | Exact Claude model IDs from the reviewed Anthropic deployment; avoid unconfigured aliases |

Keep `management-token`, wallet keypair and journal passphrase outside Desktop.
Read the inference token privately; never paste it into a chat, screenshot or
issue. The form's API-key label does not mean `x-api-key` authentication: select
Bearer to match clientd. Use the
[official gateway field reference](https://claude.com/docs/third-party/claude-desktop/gateway)
for the app's current labels. If the model-list field uses JSON, its minimal
shape is `[{"name":"EXACT_REVIEWED_CLAUDE_MODEL_ID"}]`; substitute the deployment's
actual ID before applying it.

4. Review the form's validation. **Apply Changes** writes the configuration to
   this device and relaunches Desktop. Use **Export** only when deliberately
   producing a managed configuration for other devices. Connection tests may
   contact the configured endpoint; run them only in the reviewed evaluation
   environment.

These menu and application steps follow Anthropic's
[in-app configuration guide](https://claude.com/docs/third-party/claude-desktop/in-app-configuration).
Desktop reads its third-party inference configuration; setting
`ANTHROPIC_BASE_URL` in a shell or editing Claude Code's `settings.json` is not
the Desktop configuration procedure. See the official
[Desktop gateway connection instructions](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app).

## 3. Validate before enabling funded use

**The current repository stops at this compatibility check.** No Desktop
version, complete request sequence or paid lifecycle has been validated here.
A successful settings save, model list or connection check is not a funded-use
pass. The current public profile fails the Messages prerequisite in step 1.

A deployment maintainer must first validate the actual Desktop version against
an isolated local fixture. Check the initial request, streaming, tool
continuations, cancellation, background requests and retry behavior. The
[Claude Code probe](claude-code.md#observed-blockers) documents
query, metadata and beta-header failures for that separate client; it does not
establish which requests Desktop sends.

Before a separately authorized live acceptance run, the maintainer must show
that Desktop's output limits fit the deployment and that automatic retries,
fallbacks and background requests cannot create unreviewed paid operations.
This guide does not establish a working Desktop control for those behaviors;
do not assume Claude Code CLI environment variables apply. Unknown query fields,
headers, tools, modalities and output settings require a reviewed compatibility
change, not relaxed validation or silently discarded fields.

Success means an actual Desktop request produces a usable response and a
verified SDK settlement, with the expected operation count, charge, interruption
recovery and withdrawal. Keep the same clientd profile and journal during that
verification. Until those checks exist, use [OpenClaw's documented integration](openclaw.md)
for its tested scope, or the [SDK quickstart](sdk.md) for a client
whose requests you control. See [status](../status.md) for current limits.

## Desktop MCP connectors are a separate option

For tools inside a standard Desktop conversation, Anthropic supports local MCP
desktop extensions and remote MCP connectors. Local extensions are installed
through **Settings → Extensions**; custom packages use **Advanced settings →
Install Extension…**. See the
[official local MCP guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

Solana zkAPI does not currently ship an MCP server or `.mcpb` extension.
`clientd` is an inference/management HTTP service, so its `/v1` URL is not an MCP
server URL. There is no working `mcpServers` configuration to copy from this
repository. A future connector needs an MCP adapter around the existing SDK or
clientd, explicit tool permissions, bounded inference and recovery semantics;
it must not introduce another financial state machine.

Remote custom connectors are reached from Anthropic's infrastructure, so a
`127.0.0.1` clientd address also cannot serve as a remote connector. See the
[remote MCP network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
Adding an MCP tool would let Desktop call that tool; it would not itself change
Desktop's primary inference provider or billing. Use the gateway procedure above
when primary inference routing is the goal.
