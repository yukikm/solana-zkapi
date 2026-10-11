# Finite HTTP gateway

The `.13` SDK/native release implements `finite_http_v1` through the existing proxy session,
encrypted journal and accounting ledger. It supports bounded requests and finite
streamed responses, including binary bodies, repeated headers, raw query strings
and declared trailers. This capability requires matching operator binaries and
new authenticated selection. See [support status](../support.md) for published
SDK/native and deployment availability; this guide does not upgrade a funded
profile or authorize a deployment.

The initial meters are `fixed_http`, `openai_responses` and
`anthropic_messages`. WebSockets, gRPC, asynchronous/background jobs, private
retained resources, delegated credentials and unrestricted provider endpoints
are outside this contract. Existing registered POST JSON and direct inference
profiles keep their original interfaces.

## Register and pin an operation

Use a schema 2 registration project with the existing offline
[`zkapi-api` workflow](api-registration.md). Its `services` list accepts a finite HTTP
declaration with these fields:

- `api`: the complete version 2 binding from the
  [binding schema](../contracts/universal-api-gateway.schema.json).
- `rates`: sorted tariff rate objects with `unit`, `nano_usdc_numerator`,
  `unit_denominator` and `reservation_max_count`, all counts/prices as decimal
  strings. Fixed HTTP uses one `requests` rate with denominator and maximum `1`.
- `validFrom` and `validUntil`: increasing Unix seconds as decimal strings.
- `transportArtifactSha256` and `meterArtifactSha256`: independently reviewed
  installed adapter digests. They must match the binding and destination build.
- `credentialFile`: owner-private absolute credential path when authentication
  is enabled; omit it for `none`.

The current Rust build identifies its HTTP and meter adapters by SHA-256 of
`services/control/src/gateway/http.rs` and `meter.rs` respectively. LLM meter
configuration additionally pins `services/control/fixtures/gateway-meter-mappings.json`.
A source change requires reviewing and regenerating these pins before registration.
Credentials remain in private operator configuration. Bearer and API-key adapters
read the corresponding secret value; Basic reads a closed JSON object with
`username` and `password`. None of these values belong in a public binding.

The project also requires `gateway`, copied into its schema 3 profile:

```json
{
  "capabilities": ["finite_http_v1"],
  "mounts": [{
    "prefix": "",
    "service": "weather",
    "operation": "lookup",
    "binding_hash": "<SHA256 of JCS(api)>"
  }]
}
```

An empty prefix mounts the registered paths unchanged. A prefix such as
`/weather` is removed once on a segment boundary. Mounts cannot shadow management
or model discovery routes; mixed legacy selections must have disjoint execution
routes. The tariff binds the entire descriptor, meter resource and reservation.
The compiler rejects a full reservation above the Pool authorization cap.

## Invoke from the SDK

After creating the client with its verified schema 3 profile:

```ts
const result = await client.requestApi({
  version: '2',
  service: 'weather',
  operation: 'lookup',
  operationId: crypto.randomUUID(),
  method: 'GET',
  target: '/v1/current?city=Tokyo&tag=a&tag=b%2f',
  headers: [['accept', 'YXBwbGljYXRpb24vanNvbg==']],
  body: new Uint8Array(),
});

// Header/trailer values are Base64 octets; repeated pairs stay separate.
const bytes = await new Response(result.body).arrayBuffer();
const trailers = await result.trailers;
await result.completed;
```

Consume or cancel the body. `completed` confirms the framed HTTP carrier ended
cleanly; signed receipts and settlement remain the authority for charges.
A disconnect or malformed terminal frame does not authorize retrying with a new
operation ID. Retain the operation and inspect the existing status/recovery flow.
The client does not replay an uncertain send.

Browser callers must explicitly declare the installed transport capabilities
`finite_http_v1`, `opaque_header_bytes` and `response_trailers` in
`gatewayCapabilities` before storage is opened. Capability validation does not
promise support for every browser or provider SDK.

## Invoke through clientd

Install a matching native distribution and schema 3 profile using the existing
[clientd setup procedure](clientd.md). Requests to a configured local mount use
the inference token. Send the native method, raw path/query, headers and body;
clientd constructs the authenticated carrier envelope and keeps the original
provider representation. It consumes local authentication, rejects caller
provider credentials, disables redirects and requires complete response framing.
Local preflight requests do not dispatch a billed provider request.
The native recovery hold remains until the frontend finishes the complete local
HTTP response without write errors and acknowledges that delivery to the runtime.
A disconnect or missing acknowledgement requires the original recovery flow;
finishing the internal SDK-to-frontend stream alone does not permit another send.

For Claude Code, pass the local token only through per-process
`ANTHROPIC_AUTH_TOKEN` and set `ANTHROPIC_BASE_URL` to the selected mount.
Pin `ANTHROPIC_CUSTOM_HEADERS` to `Accept-Encoding: identity`; the tested client
also offers `zstd` by default, which this contract does not enable.
An `apiKeyHelper` can emit both Authorization and `x-api-key`; the gateway rejects
caller-supplied provider credentials. Keep this configuration isolated from
existing client profiles. Pinned native-client verification is local and does not
establish public-provider compatibility.

Claude Code 2.1.220 can retry certain capability errors even with retry and
nonstreaming fallback disabled. The gateway must fence such attempts with
`recovery_required` before another authorization or provider dispatch. This is a
known client compatibility restriction, not a no-retry guarantee. Inspect status
and explicitly recover the original operation before requesting new work.

The control execution route is `POST /zkapi/v2/execute/{service}/{operation}`.
It carries the versioned binary envelope, not a provider-native JSON body.
Application code should use the SDK or clientd; the exact wire framing, completion
and receipt rules are in the [gateway contract](../specs/universal-api-gateway-contract.md).
