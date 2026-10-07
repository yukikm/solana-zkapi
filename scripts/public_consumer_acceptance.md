# Public consumer acceptance preparation

This workflow prepares the seven deliberate cases in
[the approved acceptance plan](../docs/public-devnet-acceptance-plan.md).
Preparation is offline: it does not initialize a budget, reserve AUTH, fund a
note, issue a provider key, run inference, or start a client. The final public
profile and selected authority must be reviewed before execution. Preserve all
failed observations; the seven-cap approval contains no automatic replacement.

## Build and stage the independent app

Build the independent zkchat application using the exact release prefix:

```sh
npm run build -- --base /releases/REVIEWED_REVISION/chat/
```

The source `public/zkapi-config.json` remains `null`. Create a private preparation
input JSON with exactly these fields (all file paths must be canonical absolute
paths; substitute reviewed values, not these illustrative names):

```json
{
  "schema": 1,
  "label": "Public Devnet preview",
  "profileFile": "/absolute/reviewed/profile.json",
  "profileUrl": "https://REVIEWED_HOST/releases/REVIEWED_REVISION/profile.json",
  "profileSha256": "REVIEWED_PROFILE_SHA256",
  "bundleDirectory": "/absolute/reviewed/assets",
  "appBuildDirectory": "/absolute/zkchat/dist",
  "appBase": "/releases/REVIEWED_REVISION/chat/",
  "sdkArchiveSha256": "REVIEWED_SDK_ARCHIVE_SHA256",
  "nativeArchiveSha256": "REVIEWED_NATIVE_ARCHIVE_SHA256",
  "nativeReleaseSha256": "REVIEWED_NATIVE_RELEASE_MANIFEST_SHA256",
  "grantAuthorizationSha256": null,
  "model": "openai/gpt-4o-mini"
}
```

The grant digest may remain null for preparation. A null digest does not permit
execution. An archive digest and its extracted release-manifest digest are
different pins. Run with pinned Node 24.19.0 and the existing compiled SDK:

```sh
node scripts/prepare_public_consumer_acceptance.mjs /absolute/input.json /absolute/new-output
node --test scripts/prepare_public_consumer_acceptance.test.mjs
```

The helper verifies the offline profile/bundle/manifest joins, selected model
capabilities, cap, origins and release path. It copies a bounded production
build into a new output, inserts the exact schema-2 app locator, and adds a CSP
allowing the bundled worker, WASM compilation and the profile's connection
origins. It also writes hashed native request bodies, a harmless OpenClaw read
fixture, and seven **unstarted intents**. These intent UUIDs are planning
identifiers, not observations of actual AUTH UUIDs. It refuses output reuse and
leaves a partial output intact if a write fails. The generated plan deliberately
leaves public download, full SDK authentication/preflight and authority checks
false. The helper is not a replacement for those checks.

Serve `app/` at the exact release prefix and open its explicit `index.html` URL;
no SPA fallback is needed. The source config and old builds remain unchanged.
The CSP must also be observed in the real browser before funding: local build
success alone does not establish WASM, wallet-extension or provider CORS success.

## Reusable public and native entry points

Use the independently installed candidate's `public-devnet-consumer preflight`
to authenticate actual public downloads and perform read-only chain/catalog
checks. Use its `install-native` command to create a new installation with the
same profile URL/digest, direct transport, and the private invitation token file.
Use the command's own help for the exact installed argument schema. Do not
rewrite public origins to a loopback relay. Stock `clientd setup` and `run` own
the new native custody/journal, and `clientd request` provides status, wallet,
recovery and close operations.

`clientd request` does not provide a Chat command. N-01 and N-04 therefore use one
explicit HTTP POST to the installed supervisor's loopback `/v1/chat/completions`,
its private inference token, a distinct stable `Idempotency-Key`, and the staged
request body. Do not print the token, enable redirects, retry the request, or
replace an uncertain operation with another UUID. The response and journal must
be retained privately; publish only verified aggregate evidence.

The historical `external_sdk_live.mjs` rewrites endpoints through a custom local
relay and is unsuitable for claiming stock public transport. Likewise,
`run_openclaw_clientd_acceptance.ts` is a fixture test even though it executes
OpenClaw. Its isolated configuration pattern is reusable, not its fixture result.
For actual OpenClaw, retain the pinned installed version, use a new private
workspace/config, allow only `read`, disable plugins and fallbacks, set provider
retries to zero, and configure the reviewed model with at most 128 output tokens.
N-02/N-03 must produce exactly the intended two operations. Inspect the actual
client configuration before execution; do not assume a tool prompt limits the
number of provider calls. Preserve the 120-second settlement wait and provider
grace rather than reducing either to accommodate the client.

### Hard two-call OpenClaw input gate

`public_openclaw_input_gate.mjs` is an explicit **acceptance-only incoming HTTP
gate**, positioned between actual OpenClaw and the stock supervisor's loopback
Chat API. It does not rewrite or relay Devnet/provider egress. Evidence must name
this local input gate rather than claiming that OpenClaw connected without it.
Its dedicated private config has exactly these fields:

```json
{
  "upstreamOrigin": "http://127.0.0.1:REVIEWED_CLIENTD_PORT",
  "tokenFile": "/absolute/new-native-profile/inference-token",
  "stateDirectory": "/absolute/new-private-gate-state",
  "model": "openai/gpt-4o-mini",
  "listenPort": 0
}
```

Both config and token must be owner-only regular files. Start it once with
`node scripts/public_openclaw_input_gate.mjs /absolute/gate-config.json`; it prints
only the loopback origin and limit. Use a new directory; an existing/partially
initialized directory refuses reopening. Never create another gate directory
to replace failed paid calls. Permanent slot markers are fsynced before each
forward; unknown results do not release slots. The gate allows exactly the
Chat POST path, the native inference token, reviewed model, streaming, 1–128
output tokens and the sole `read` tool. The first input has no tool-result
message; the second has exactly one. It passes body/response bytes unchanged,
retains or supplies one stable operation id, rejects duplicate input or operation
ids, serializes active inputs, rejects the third before clientd, and never follows
redirects or retries. Request/response byte limits and disconnect propagation
remain enforced. The markers contain hashes/operation ids, not prompts or tokens;
retain them privately. They count input reservations, not observed AUTH/provider
dispatches. Native management/recovery requests go directly to stock clientd.

Generate actual OpenClaw config using the installed native command
`clientd openclaw-config PROFILE --model openai/gpt-4o-mini --context-window 32000 --max-tokens 128`.
In a new private copy only, set `models.providers.zkapi.baseUrl` to the gate
origin plus `/v1`; retain the generated file SecretRef pointing at the native
inference token. Set `agents.defaults.workspace` to the new fixture directory,
`skipBootstrap: true`, `thinkingDefault: "off"`, `tools: {"allow":["read"]}` and
`plugins: {"enabled":false}`. Also set `tools.toolSearch: false`: the pinned
OpenClaw otherwise adds catalog search/describe/call tools even with the read
allowlist. Preserve the generated empty fallback list and
`maxConcurrent: 1`. The current installed CLI validates these fields. Use an
isolated `HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`, and a new explicit
session id. Validate with `openclaw config validate --json` before the actual
single `openclaw agent --local --agent zkapi --session-id ... --message ...
--thinking off --timeout 600 --json` invocation. The message asks to read only the
staged `probe.txt` once and report its contents without another tool. Do not add
an invented CLI request-count flag; the durable input gate supplies that bound.
Retain actual CLI output privately and independently verify both settlements.

The opt-in local probe is selected with `ZKAPI_OPENCLAW_INPUT_GATE_TEST=1` in
`run_openclaw_clientd_acceptance.ts`, with `ZKAPI_OPENCLAW_ENTRYPOINT` pointing at
the pinned installed CLI and a new output directory. The 2026-10-08 run passed
11 checks using actual OpenClaw 2026.9.8, the production Go HTTP frontend and
compiled SDK, but synthetic control/provider/proof/chain fixtures. Its tool
exchange produced exactly two gate forwards, two provider EOF observations and
zero provider-stream cancellations, while the second request waited through a
synthetic 1.5-second settlement delay. The full fixture included eight synthetic
inferences/authorizations; these are not the seven funded acceptance cases and
consumed no real-provider reservation. Separate gate tests cover eight refusal,
durability, response-bound and cancellation cases. The earlier failed probe is
preserved: the read allowlist alone exposed three catalog tools, so the strict
gate refused the first tool input before forwarding. The narrow fix was the
supported `tools.toolSearch: false` configuration, without widening native or
gate validation. Actual provider grace, public transport, browser behavior and
native process restart still require their separate live observations.

## Browser and interruption observations

Use real Chrome with the selected Phantom account. Unlock/connect and explicit
deposit/withdrawal confirmations may require user interaction. Never import a
wallet seed into automation or bypass a browser block. Use a fresh explicit
profile-bound note (4 test USDC for the browser, 5 for native); do not migrate
existing browser custody or alter its original pins.

B-01/B-02 use the independent app's nonstreaming and streaming controls and the
same conversation/note. B-03 must observe inference dispatch and a durable
unresolved operation before terminating the page, then reopen the same origin,
storage and profile for explicit recovery. N-04 similarly terminates the actual
stock supervisor and restarts its same custody/journal. A settled restart or a
graceful cancellation is not evidence of the requested interruption boundary.
If that boundary is missed, retain the failed observation and stop: no automatic
additional paid request is allowed. Recovery does not replay inference.

Record public hashes, exact client versions, verified settlements, separate AUTH
identity/packet and inference counts, finalized funding/withdrawal receipts and
independent balances. Unknown counts remain unknown. Neither generated config,
unit tests nor browser fixtures establish funded public/Phantom acceptance.
