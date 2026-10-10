# Maintain the legacy OpenClaw settlement adapter

For a new installation, follow [OpenClaw setup](openclaw.md). This adapter is for
the **earlier zero-reuse, two-call OpenRouter preview** used by the recorded
public OpenClaw tests. It is not part of the packaged clientd installation and
is not a general-purpose OpenClaw gateway.

Earlier native inputs selected zero key reuse and a 120-second wait for the next
operation. Direct OpenRouter settlement could take longer: the operator first
disables the key, then waits for final usage before signing the successor.
The response finalizer requests close but does not wait for final settlement
before ending the response. A completed response could therefore be followed
by HTTP 409 while settlement was pending.

[`public_openclaw_settlement_gate.mjs`](../../scripts/public_openclaw_settlement_gate.mjs)
was the explicit scheduling adapter for that workflow. Its presence is a
requirement of the recorded [public N-02/N-03 result](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md);
the result does not establish immediate continuation against the stock native
port. Keep its original runtime/profile settings when maintaining that workflow.
Historical completed lifecycles must not be replayed.

**Current `.8` generated inputs use 60-second key reuse.** The adapter explicitly
rejects any native status whose `key_reuse_seconds` is not zero. Do not alter an
existing profile or downgrade a new installation to fit this adapter. Current
reuse/settlement behavior has its own [release scope](../releases/session-reuse-preview.md)
and does not inherit this historical funded result.

## 1. Check prerequisites

Use the original running, funded zero-reuse profile and exact model from its
reviewed deployment. Only this adapter and one OpenClaw client may use the
profile during the bounded run. Native status must show direct OpenRouter,
zero reuse, an active wallet, no wallet operation/emergency escape/recovery
requirement, and a ready session with no unresolved operations.

The adapter imports `packages/sdk/dist/trust.js` from a source checkout. Use a
reviewed checkout and the repository's pinned Node/npm toolchains. If its
compiled SDK is absent, build it from that checkout, outside every immutable
native installation:

```sh
cd /absolute/path/to/solana-zkapi
npm ci --ignore-scripts
npm run build:sdk
```

Do not copy the adapter into an existing native installation: that would break
its complete-file manifest. Keep the installed native package unchanged.

## 2. Create a private adapter configuration

Save the following exact field set as `/absolute/private/openclaw-gate.json`,
substituting the original profile paths, configured model, native port and a new
state directory. The example native port is `8787`; use the actual original
listener. The state directory must not exist, and its parent must already exist.

```json
{
  "listenPort": 56738,
  "model": "openai/gpt-4o-mini",
  "stateDirectory": "/absolute/private/new-adapter-state",
  "tokenFile": "/absolute/original-profile/inference-token",
  "managementTokenFile": "/absolute/original-profile/management-token",
  "upstreamOrigin": "http://127.0.0.1:8787"
}
```

Configuration and token files must be owned by the current user with no group
or other permissions; paths must be absolute and canonical, with no symlinks.
The separate management token is used only for native status reads. It is never
sent to OpenClaw or to the inference route.

```sh
chmod 600 /absolute/private/openclaw-gate.json
node /absolute/path/to/solana-zkapi/scripts/public_openclaw_settlement_gate.mjs \
  /absolute/private/openclaw-gate.json
```

Keep the process in the foreground. Successful startup prints the adapter origin,
`maximumForwarded: 2` and `automaticReplay: false`. This confirms local startup;
it does not reserve provider capacity or prove live settlement readiness.

## 3. Point the bounded OpenClaw run at the adapter

Use the reviewed OpenClaw configuration for the original profile. Make a
separate configuration copy and change only
`models.providers.zkapi.baseUrl` to `http://127.0.0.1:56738/v1`. Its file SecretRef
still points to the original **inference** token. Do not give OpenClaw the
management token. Select the copy with `OPENCLAW_CONFIG_PATH` and validate it:

```sh
OPENCLAW_CONFIG_PATH=/absolute/private/openclaw-via-gate.json \
  openclaw config validate --json
```

Use the pinned OpenClaw 2026.9.8 executable as in the [setup guide](openclaw.md);
if it is not on PATH, call its exact `openclaw.mjs` entry point through Node.
Keep provider retries disabled, `read` as the only tool, plugins disabled,
streaming enabled and the output limit at 128 tokens or fewer. In the generated
configuration, the restricted tool settings are
`"tools":{"allow":["read"],"toolSearch":false}` and
`"plugins":{"enabled":false}`; the embedded-agent retry file remains unchanged.

The adapter accepts exactly the shape of a bounded read-tool roundtrip:

1. A first streaming Chat request with no tool result and exactly the `read`
   tool declaration.
2. A second streaming request containing exactly one tool result, forwarded
   once the first operation's settlement has been observed.

Each input has distinct body bytes and a distinct operation UUID. There is no
third request and no text-only-then-tool-run sequence within one adapter state.
A third input receives HTTP 429. Follow the operator's separately reviewed run
instructions for the intentional funded turn; do not replay a historical test
or delete state markers to reuse its two slots.

After the bounded run, inspect native status and complete settlement/recovery
through the original installation. Press Ctrl+C to stop the adapter and preserve
its private state directory. Stopping it neither closes the native session nor
withdraws the note. A stopped/failed adapter never resumes an existing directory.

## Scheduling and evidence

Before the first forward, the adapter requires authenticated native status to be
ready. After fully consuming the first HTTP 200 response, it must observe that
exact operation UUID as the sole unresolved operation in the closing phase. If
the pending identity was not observed, it refuses continuation rather than
inferring which operation settled.

Nonterminal SSE events stream normally. The adapter preserves but withholds the
first response's terminal `[DONE]` event until native HTTP EOF and the pending
identity check complete. This lets consumers issue the next request, or cancel
their response reader, immediately at `[DONE]` without racing the scheduler's
completion state. Cancellation before that terminal event fails closed.

The second request is held in memory with a durable private UUID/body-digest
marker. The adapter polls only `GET /admin/status`, at one-second intervals with
three-second request deadlines, for at most ten minutes. It requires unchanged
mode, zero key reuse, active wallet, no wallet operation or emergency escape,
monotonic journal heads, and no recovery requirement. Forwarding occurs once
after status is ready, unresolved operations are empty, and the journal head has
advanced beyond the observed pending head. The balance may only decrease within
the existing one-USDC session cap.

This is an authenticated observation of the native SDK's verified journal state.
The adapter does not independently decode settlement receipts, reveal AUTH
secrets, or claim that a journal digest by itself proves a signature. The
independent acceptance observer remains responsible for receipt and chain
evidence. `held-second.json`, `first-settled.json`, and the existing forward
markers retain the scope and observed heads without storing prompts or keys.

No AUTH, inference, close, recover, wallet action, or provider request is issued
by the scheduling loop. Stock native background maintenance performs the
existing settlement recovery. A timeout, disconnect, status error, mismatched
identity, failed stream, or uncertain marker poisons the adapter and leaves all
state in place. It never retries an inference or adopts an existing state
directory. Inspect the retained native and adapter state explicitly; do not
delete markers to replay an input.

The adapter's ten-minute ceiling does not override a caller's shorter timeout.
Caller cancellation remains a refusal, not permission to retry. Current local
fixture checks are separate from actual funded OpenClaw acceptance.
