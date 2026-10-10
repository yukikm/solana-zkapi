# Call the local HTTP API

Use this guide to send one text request from your own script through clientd.
You do not need to import the zkAPI SDK or expose your wallet to the script.
The result is a consumed Chat Completions response and a separately checked
settlement. For full wallet/application integration, use [the SDK](sdk.md).

## 1. Prepare the local client

Complete [clientd setup](clientd.md), including preflight and funding. Keep it
running. In a second terminal, restore your paths and inspect the note and model
list:

```sh
ZKAPI_ROOT="$(cd "$HOME/.local/share/zkapi" && pwd -P)"
ZKAPI_INSTALL="$ZKAPI_ROOT/release-0.2.0-devnet.8/zkapi-clientd-0.2.0-devnet.8-darwin-arm64"
ZKAPI_PROFILE="$ZKAPI_ROOT/profile-sdk8"
export PATH="$ZKAPI_INSTALL/bin:$PATH"
clientd request "$ZKAPI_PROFILE" status
clientd request "$ZKAPI_PROFILE" models
```

Choose an exact model ID with Chat support. The public profile's configured
output limit is 128 tokens. Status should show `wallet_status: "active"`,
`phase: "ready"`, no wallet operation, no emergency escape, no unresolved
operations and no recovery requirement before starting this fresh session.
Check the note can cover the profile's authorization cap.

The local endpoint is `http://127.0.0.1:8787/v1/chat/completions`. Its credential
is `PROFILE/inference-token`. Keep `management-token`, wallet keys and the
passphrase out of HTTP clients. The remote public deployment origin is not an
OpenAI-compatible inference endpoint for the public direct-mode profile.

## 2. Send one deliberate request

The following command consumes provider capacity and note balance. Set the
model ID from the preceding list, then run it once. It uses bundled Node, reads
the credential file internally and makes one fetch with no retry or redirect.

```sh
ZKAPI_MODEL='YOUR_ADVERTISED_CHAT_MODEL_ID'
"$ZKAPI_INSTALL/bin/node" --input-type=module - "$ZKAPI_PROFILE" "$ZKAPI_MODEL" <<'JS'
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const [profile, model] = process.argv.slice(2);
const token = (await readFile(join(profile, 'inference-token'), 'utf8')).trim();
const operationId = crypto.randomUUID();
console.log('Operation ID:', operationId);
try {
  const response = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(600_000),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': operationId,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with a short hello.' }],
      max_tokens: 128,
      stream: false,
    }),
  });
  const text = await response.text();
  console.log('HTTP status:', response.status);
  console.log(text);
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error('Request interrupted:', error instanceof Error ? error.name : 'unknown');
  console.error('Inspect the same clientd profile before starting another request.');
  process.exitCode = 1;
}
JS
```

A successful response is provider-native Chat JSON containing assistant text.
The operation ID identifies this intentional request; re-running the script
creates a new request and can charge again. A lost response cannot be recovered
by changing the UUID or replaying inference.

## 3. Check settlement

After the response has been consumed, run:

```sh
clientd request "$ZKAPI_PROFILE" status
clientd request "$ZKAPI_PROFILE" close
clientd request "$ZKAPI_PROFILE" status
```

Successful response delivery and signed settlement are separate results. A
reused direct session can stay active until close/expiry. Wait for settlement
and inspect the final balance, empty unresolved-operation list and ready state.
If a request failed or status remains pending, use [recovery](recovery.md).
Closing the API session does not withdraw the note; use the
[withdrawal steps](clientd.md#stop-restart-and-withdraw) when finished.

## Other clients and APIs

Configure an OpenAI-compatible client with base URL
`http://127.0.0.1:8787/v1`, the inference token, exact configured model, bounded
output and disabled retries/model fallbacks. Its complete request shape still
needs compatibility validation. Do not hand the client an operator management
key. [OpenClaw](openclaw.md) has its own concrete setup procedure.

The deployment's mode, provider and advertised model APIs select usable routes:
Chat Completions is not interchangeable with Responses or Anthropic Messages.
Use [deployment inputs](deployment-inputs.md#model-configuration) for that matrix,
[Claude Desktop](claude-desktop.md) for its gateway contract and
[client compatibility](../integrations/README.md) for known blockers.

For streaming, consume the entire SSE body or explicitly cancel it, then inspect
status. A disconnect does not prove zero usage. Applications execute their own
tools and retain their own conversation history; zkAPI does not replay old model
responses or execute client tools.
