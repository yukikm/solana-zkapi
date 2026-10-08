# OpenClaw settlement scheduling adapter

The released native preview selects zero key reuse and a 120-second wait for the
next operation. Direct OpenRouter settlement can take longer: the operator first
disables the key, then waits for stable final usage before signing the successor.
A completed response can therefore be followed by HTTP 409 while settlement is
still pending. The response finalizer requests close; it does not wait for final
settlement before ending the response.

`scripts/public_openclaw_settlement_gate.mjs` is an explicit local consumer
adapter for the bounded two-call OpenClaw preview. It preserves the released
native runtime and profile settings. Its scheduling behavior must be included
when describing an OpenClaw result; it does not establish that an unmodified
OpenClaw client can immediately send another request to the stock native port.

## Configuration

Create a private JSON file containing these exact fields. The state directory
must not exist; its parent must already exist. Both token files must be owned by
the current user with no group or other permissions. The management credential
is separate from the inference credential and is never sent to OpenClaw or to
the inference route.

```json
{
  "listenPort": 56738,
  "model": "openai/gpt-4o-mini",
  "stateDirectory": "/absolute/private/new-adapter-state",
  "tokenFile": "/absolute/private/inference-token",
  "managementTokenFile": "/absolute/private/management-token",
  "upstreamOrigin": "http://127.0.0.1:8080"
}
```

Run the script with the private configuration path as its only argument. Point
the reviewed OpenClaw model endpoint to the adapter's loopback port. Keep provider
retries disabled, the read tool as the only tool, streaming enabled, and the
output limit at 128 tokens or fewer. The adapter accepts at most two distinct
request bodies and operation UUIDs. The first request has no tool result; the
second has exactly one. Only one adapter/client may use the native profile during
this run. Its existing SDK build output is required for the strict JSON reader.

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
