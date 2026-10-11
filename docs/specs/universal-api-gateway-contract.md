# Universal API gateway: finite HTTP contract

Normative initial implementation contract, 2026-10-12. This accompanies the
[gateway design](universal-api-gateway.md); it does not amend currently accepted
version 1/2 objects or advertise a deployed endpoint. Async and duplex extensions
are outside this contract.

## Types and authenticated selection

All objects below are closed: reject duplicate/unknown JSON keys, invalid UTF-8,
noncanonical numbers, unexpected nulls and trailing input. `Uint` means a
canonical decimal string (`0` or a nonzero digit followed by digits), not a JSON
number. IDs use the existing API identifier grammar, UUIDs use canonical
lowercase UUIDv4, and hashes use 64 lowercase hexadecimal digits. All hashes are
SHA-256; JCS uses the existing implementation. Integer bounds below are inclusive.
Only `resource`, the listed receipt fields and error identities allow null.

The exact required fields of `ApiBindingV2` are:

```text
version: "2"
service: ApiIdentifier
operation: ApiIdentifier
mode: "proxy"
transport: AdapterPin
origin: canonical HTTPS origin
routes: Route[]
query: "preserve"
headers: HeaderPolicy
representation: RepresentationPolicy
limits: Limits
authentication: AuthenticationPolicy
privacy: { identifiers: "allow" | "reject_by_meter",
           resources: "stateless" | "shared_public" }
meter: Meter
completion: Completion
recovery: { policy: "finite_unknown_v1", reconciliation_seconds: "900" }
```

`AdapterPin` has exactly `{id, version, artifact_sha256}`; ID uses the API
identifier grammar and version is a positive `Uint` within u32. Initially
transport is `http_finite` version `"1"`; the installed artifact hash must match
independent runtime build pins. Meter IDs are `fixed_http`, `openai_responses`
and `anthropic_messages`, each version `"1"`. No runtime downloads are permitted.
The binding is at most 8 KiB JCS; the existing 16 KiB SessionCreate bound still
applies to the complete quote/proof/authorization. Oversized registrations fail.

All v2 bindings use the existing generic quote shape: `provider:"generic"`,
`api:ApiBindingV2`, and **omitted** `models`. A new gateway OpenAI binding is not
an old inference quote with `provider:"openai"`. Its provider/resource identity
is inside the binding. The quote's tariff hash and full binding must equal the
locally loaded authenticated service. Keep authorization version `"1"` and the
quote signature algorithm unchanged. A session fixes exactly one binding,
resource and tariff; changing any requires settlement and a new quote.

Before quote/AUTH, a native resource selector may read a bounded shadow JSON
object to choose one installed binding by exact model ID. Reject duplicate keys,
invalid JSON and ambiguous/no matches. The selector cannot return a destination,
tariff or resource absent from the profile. Dispatch repeats that validation
against the saved binding. Fixed opaque services have no selector.

## Routing, headers and credentials

`Route` is exactly `{method, path}`. Method is one of `GET`, `POST`, `PUT`, `PATCH`,
`DELETE`, `HEAD`, `OPTIONS`. There are 1–32 unique routes sorted by method then
path. Path is an ASCII origin-relative pathname of at most 1,024 bytes, with
whole-segment parameters spelled `{name}` (unique API identifiers). A parameter
matches one nonempty segment of at most 256 raw bytes; there are no wildcards,
optional segments, substitutions or regexes. Literal segments compare byte for
byte. Registration rejects intersecting routes unless the exact resource
selector above resolves different bindings uniquely. The selected operation
uses the original target, not a template expansion.

The raw target is ASCII, begins with one `/`, and contains no fragment, backslash,
control, space or malformed percent escape. A single `?` separates the pathname
from its raw query; later question marks are query bytes. Reject empty interior
path segments, literal or encoded dot segments, encoded `/` or `\\`, and encoded
`%` in the pathname, case-insensitively. Decode each segment once only for these
checks and reject decoded controls. The sender must accept the exact validated
target without URL-library normalization. Query octets, including `+`, escaped
delimiters, repeated keys and a trailing `?`, are preserved without form decoding.
The initial credential set injects no query keys. A query-constraining policy
requires a separate installed contract; it is not an implicit parser here.

`HeaderPolicy` has exactly:

```text
request: "end_to_end"
request_reject: lowercase-header-name[]
response: "end_to_end"
response_reject: lowercase-header-name[]
trailers: lowercase-header-name[]
static_request: [lowercase-header-name, canonical-padded-Base64-value][]
```

Name arrays are sorted, unique and contain at most 64 entries. Header names use
HTTP token syntax; values permit HTAB, SP, visible ASCII and obs-text octets, but
not other controls, CR, LF or DEL. Remove only leading/trailing SP/HTAB before
commitment. Preserve the order of same-name values; do not merge them. Reject
duplicates of singleton fields (including Content-Type, Content-Encoding, Host,
Authorization and authentication injection fields) rather than choosing a value.
Native and SDK paths apply the same rule before any lossy header conversion.

Hop framing is validated at the ingress HTTP parser, never trusted from envelope
metadata. Remove hop-by-hop headers and Connection-nominated fields, Host,
Content-Length, Expect, all `proxy-*`, `x-zkapi-*`, `forwarded`, `x-forwarded-*`,
and local authentication/Idempotency-Key fields before computing semantic pairs.
CONNECT, TRACE, upgrades and request trailers are unsupported initially. A
body on GET/HEAD is rejected; other registered methods may have a zero-length
body. Local OPTIONS preflight handling never enters this billed route.

Consumer-supplied provider Authorization, Cookie and the selected upstream
credential field are rejected in envelope semantic headers, not treated as
delegation. Native local authentication is consumed before this step. Static
request fields are public, sorted using semantic-pair order, cannot use reserved
names, and reject caller collisions. They are injected once by the dispatcher
after binding; their nonsecret values are committed by the binding hash.
No implicit User-Agent or Accept-Encoding is added by the provider HTTP client.

Response policy always strips hop/framing/control/forwarding fields and provider
Set-Cookie, WWW-Authenticate, Proxy-Authenticate, CORS and browser policy headers
(CSP, HSTS and Cross-Origin-*). Explicit reject lists apply in addition. Clientd
owns local security headers and `Cache-Control: no-store`. Header preservation
is subject to this named policy. The sole Content-Length exception is HEAD/304:
retain a valid singleton value as representation metadata, not a body-length
requirement. Strip it from every other downstream response, including 204/205.
Trailer names must be declared and cannot be
framing, authentication, content-selection or control fields. A consumer that
cannot receive required trailers fails before AUTH. Initial native profiles
reject redirects; SDK-only exposure requires the design's no-follow contract.

`AuthenticationPolicy` is one of these closed shapes:

```text
{scheme:"none", policy_id:ApiIdentifier}
{scheme:"bearer", policy_id:ApiIdentifier}
{scheme:"api_key_header", policy_id:ApiIdentifier, header:lowercase-header-name}
{scheme:"basic", policy_id:ApiIdentifier}
```

Private configuration maps policy ID to an owner-private credential reference;
values never enter the binding. Header adapters inject exactly one value;
Bearer/Basic use Authorization. API-key headers cannot use a hop/control name.
Basic encodes the configured username/password octets, rejects a username
containing `:`, and is used only over HTTPS. Credential renewal cannot change
the configured provider account/tenant; replacement identity requires a new
binding. Loopback HTTP is allowed only by explicit synthetic-fixture build policy,
never by a public profile. Public DNS/IP and TLS checks remain mandatory at every
connection; redirects, HTTP-library retries and speculative sends are disabled.

## Representation, limits and completion

`RepresentationPolicy` has exactly `{request_media_types, response_media_types,
request_encoding, response_encodings}`. Media-type lists are nonempty, sorted,
unique lists of lowercase type/subtype values (no parameters), or `["*"]` for
opaque services. Keep original Content-Type bytes including parameters. Empty
bodies may omit Content-Type; nonempty bodies need it unless the list is `["*"]`.
Request encoding is `"identity"`; absent Content-Encoding is identity. Response
encodings are a nonempty sorted subset of `identity`, `gzip`, `deflate`, `br`,
always including identity. Fixed opaque meters do not decode responses; LLM
meters decode a bounded observation copy while preserving original encoded bytes
for the consumer. Support single encodings only: gzip, zlib-wrapped deflate and
Brotli with end/checksum validation as applicable. Reject stacked encodings.
Transparent HTTP decompression is disabled. No body normalization is performed.

Accept-Encoding, including valid q-values, remains a semantic committed header;
do not confuse it with request Content-Encoding. Before AUTH, reject malformed
negotiation, wildcard codings, or a nonzero offered coding outside the registered
response set. Native LLM profiles must declare and test all codings offered by
their pinned clients. An absent header causes no implicit HTTP-client header
injection. Unsupported actual response encoding, corrupt/truncated compressed
data or decoded bounds failure is an unknown post-dispatch outcome, not a zero
usage observation. Unknown observation does not authorize a resend.

`Limits` contains all the following `Uint` fields; no defaults are inferred from
an untrusted descriptor. Operators may select lower values within these ranges.

| Field | Allowed range / meaning |
|---|---|
| `target_bytes` | 1–8,192, raw target |
| `header_pairs` | 1–128 in each request/response/trailer collection |
| `header_bytes` | 1–32,768, sum of ASCII name lengths and decoded value lengths per collection |
| `request_bytes` | 0–1,048,576, complete raw body |
| `response_bytes` | 0–16,777,216, aggregate raw response data, not per chunk |
| `decoded_response_bytes` | 0–67,108,864, aggregate decoded observation bytes |
| `decode_ratio` | 1–64, decoded bytes / max(1, raw bytes consumed), checked on each decoder output |
| `parser_bytes` | 1–1,048,576, maximum shadow JSON object or individual SSE event |
| `relay_buffer_bytes` | 1–1,048,576 per operation; no unbounded tee queue |
| `header_seconds` | 1–600, within the total execution deadline |
| `idle_seconds` | 1–600, within the total execution deadline |
| `execution_seconds` | 1–600 from durable DISPATCHING commit |
| `max_concurrency` | 1–4, also bounded by the authenticated session |

The immutable execution deadline includes connect, upload and response. Slow
consumers may lose their relay once its bounded queue fills; independent usage
observation continues within the same deadline. No extension of the reservation,
deadline or admission lease follows from progress or consumer disconnect.
Dispatcher IPC stays at most 610 seconds; reconciliation targets 900 seconds
subject to finished/fenced ownership. SDK/clientd/frontend budgets must exceed
the selected inner execution budget plus their separately bounded preparation
wait; validation rejects an inconsistent runtime profile. The native gateway
bounds prior successful settlement observation to 45 seconds and new admission
(quote, proof, verification and AUTH) to 180 seconds. Its 660-second carrier
budget starts separately. A following request may wait one additional second
for the local frontend's delivery acknowledgement, keeping the composed
886-second bound below the native
900-second response-header budget. An admission timeout discards late preparation
results and never authorizes a delayed upstream send. Note expiry checks remain
mandatory and cannot be relaxed by these limits.
Decoders share the parser/relay memory budgets; streaming expansion cannot
allocate an entire decoded response. Fixed opaque meters enforce raw limits and
do not apply a decoder; their decoded limits remain inert but authenticated.

`Completion` has exactly `{kind, billable_statuses}`. Statuses are sorted unique
integer JSON numbers in 200–599, at most 400 entries. Kind is
`http_complete` for fixed meters or `provider_terminal_usage` for LLM meters.
The response must finish within limits, pass HTTP body-length rules and all
declared trailers must arrive. A complete response in the configured status set
satisfies fixed completion (`requests=1`); a complete other status does not
(`requests=0`). 202 is an HTTP response only, not evidence of completed remote
work; async jobs cannot use this rule without a separately enabled capability.
Truncation/timeout/framing/observation failure is unknown, never `requests=0`.

For LLM meters, successful JSON final objects or final SSE usage and terminal
events establish measured counts, including incomplete/failed generations when
the pinned adapter has complete accounting evidence. A complete non-2xx without
such evidence is unknown unless the pinned provider contract explicitly attests
zero usage for that case. Client-visible HTTP status alone cannot establish free
execution. Completion satisfaction and charge are distinct for usage meters.
For usage meters, `satisfied` additionally requires a successful terminal outcome:
OpenAI `completed`, or Anthropic `end_turn`, `stop_sequence`, or `tool_use`.
Other terminal outcomes (including OpenAI `failed`/`incomplete` and Anthropic
`max_tokens`/`refusal`/`pause_turn`) remain measured when usage is complete, but
their completion is `not_satisfied`; they do not clear the native retry hold.

## Meter and tariff v3

`Meter` has exactly `{adapter, resource, config, config_hash}`. `adapter` is an
AdapterPin and `config_hash=SHA256(JCS(config))`. `resource` is null for fixed
opaque APIs; LLM meters use exactly `{provider, model}` with provider `openai` or
`anthropic` matching the adapter and exact nonempty model ID (at most 256 ASCII
bytes). All model aliases, service tiers and feature policy are pinned before
quote selection; no fallback model is selected during dispatch.

Fixed meter config is exactly `{exposure:"operator_upstream_cost"}`. LLM config
is exactly `{provider_contract_sha256, context_max_tokens, output_max_tokens,
service_tier, extra_cost_policy}`. Token maxima are positive Uint within i64;
tier is a nonempty ASCII string of at most 64 bytes and must match the selected
request or the adapter's pinned omitted-field default. `extra_cost_policy` is
`reject_unclassified` or `operator_absorbs_unpriced`. The latter expressly assigns
unpriced provider charges to the operator without adding receipt units or
charging the customer. It does not waive privacy, resource-ownership or
request-size restrictions. The contract digest identifies a tracked provider
mapping fixture shipped with the adapter, including terminal events, supported
usage paths, missing-field rules and features; it is not a mutable URL.
`privacy.identifiers:"reject_by_meter"` is invalid with the opaque fixed meter.
For an LLM meter, the pinned provider mapping specifies the exact rejected
identifier fields and rejects them before AUTH without rewriting the body.

Reuse existing OpenAI inclusive-input minus cache equations and Anthropic
separate input/cache-write/cache-read equations. Reasoning/thinking is part of
output, not an extra additive charge. Never sum cumulative SSE snapshots; accept
identical repeats idempotently, reject conflicting final observations. Unknown
events can pass through, but cannot replace required final accounting evidence.
Shadow parsers reject duplicate keys, cap depth at 64 and do not mutate payloads.
Missing output limits reserve the pinned maximum; supplied limits exceeding it
are rejected. No guessed tokenizer or provider count request establishes a bound.

`TariffV3` has exactly the existing generic tariff fields, with these changes:

```text
tariff_hash, version:"3", provider:"generic", api:ApiBindingV2,
pricing_basis:"fixed_request" | "fixed_usage_rates",
valid_from, valid_until, rates:RateV3[], operator_fee_micro_usdc:"0"

RateV3 = {unit, nano_usdc_numerator, unit_denominator, reservation_max_count}
```

Omit `model`; explicit null/empty legacy model fields are invalid. Hash all fields
except `tariff_hash`, exactly as today. Validity retains the existing quote-time
checks. Unit IDs match `[a-z][a-z0-9_]{0,63}`; rates are ASCII-sorted, unique,
nonempty and at most 32. Numerators/counts are 0–2^63−1; denominators 1–2^63−1.
Fixed tariffs have exactly `requests`, denominator `1`, positive numerator and
reservation maximum `1`. Usage tariffs match the pinned meter's exact unit set.

Cross-field validation is mandatory in every validator and at dispatch:

| Meter | Pricing basis | Completion kind | Resource |
|---|---|---|---|
| `fixed_http` | `fixed_request` | `http_complete` | null |
| `openai_responses` | `fixed_usage_rates` | `provider_terminal_usage` | exact OpenAI model |
| `anthropic_messages` | `fixed_usage_rates` | `provider_terminal_usage` | exact Anthropic model |

All other combinations are invalid, including use of a positive-price fixed
tariff as an implicitly free count_tokens operation.

Initial reservation is the **full** tariff maximum:

```text
R = ceil(sum(reservation_max_count_i * numerator_i / denominator_i))
C = ceil(sum(observed_count_i * numerator_i / denominator_i))
charged = min(C, R)
operator_loss = C - charged
session_charge_micro = ceil(sum(charged) / 1000)
```

All rate terms use exact rational arithmetic and aggregates fit NUMERIC(38,0).
Adapter configuration must bound every enabled priced category within the rate
maxima; configuration and dispatcher independently reject inconsistent bounds.
For the initial LLM mapping, each possibly overlapping cache/input unit reserves
up to the pinned context maximum and output reserves its maximum. This deliberately
conservative sum must fit the immutable Pool/session cap; otherwise do not
advertise/admit that binding. A smaller request-based reservation needs a new
specified and independently verifiable algorithm, not an adapter override of R.
Observations may exceed predicted maxima within i64; preserve them and cap charge.

## Operation HMAC encodings

Use the design's v2 HMAC formula with precisely these parts, in this order:

| Part | Bytes |
|---|---|
| deployment_id | UTF-8 of the exact authenticated string, no normalization |
| pool | Canonical base58 decode to 32 bytes |
| authorization_id | UUID decode of authorization.request_id to 16 RFC 4122 network-order bytes |
| operation_id | UUID decode to 16 RFC 4122 network-order bytes |
| binding_hash | 32 raw bytes, SHA256(JCS(ApiBindingV2)) |
| tariff_hash | Canonical hex decode to 32 bytes |
| method_ascii | Exact registered uppercase ASCII method |
| raw_target_ascii | Exact validated target, after native mount-prefix removal |
| semantic_header_pairs | UTF-8 JCS of lowercase-name/Base64-value pairs; ASCII-sort distinct names, preserve same-name order |
| raw_body_bytes | Complete raw bytes, including empty body |

`frame` is u16be label length, ASCII label, u16be part count, then u32be length
plus bytes for each part. Label is `solana-zkapi-operation-v2`; part count is 10.
HMAC key is SHA256(ASCII(`zkapi-proxy-body-v2`) || raw32 proxy secret). Return a
32-byte MAC, represented as lowercase hex in records. Persist it before the
client's atomic send/redaction transition. Credentials are not semantic headers;
public injected fields are committed by binding hash, as in the design.

The tracked [synthetic vectors](../contracts/universal-api-gateway-vectors.json)
include a complete binding/tariff, empty GET and binary POST, repeated query and
header values, raw obs-text header octets and every encoded HMAC part. The test
key is public synthetic material. `scripts/check_design.py` checks these hashes,
frames and per-part mutations offline; this is not an implemented gateway test.

Identical ID/commitment returns the existing 409 `operation_in_progress` or
`response_not_replayable` plus validated status identity, never provider bytes.
Changed commitment gives 409 `idempotency_conflict`. Status remains available
after expiry. Neither identity comparison nor a lost response authorizes a resend.

## Execution frame grammar

Outer request Content-Type is `application/vnd.zkapi.http-request.v2`; Accept is
`application/vnd.zkapi.http-response.v2`. Neither allows content encoding.
Request metadata has exactly `{version:"2", binding_hash, method, target,
headers, body_length}`. Its 4-byte big-endian length is 1–65,536; `body_length`
is Uint. Require exactly that many body bytes and clean request EOF before
reservation/dispatch; reject trailing bytes. Outer service/operation path,
metadata binding and authenticated quote must agree. Validate and buffer under
bounded admission concurrency before any financial reservation; incomplete
uploads cannot exhaust session reservations. Authentication precedes buffering.

A framed outer response uses HTTP 200 and the response media type, with no
content encoding, redirect, caching or intermediary buffering. A provider status
is carried only inside HEADERS. Each frame is tag:u8, length:u32be, payload:

| Tag | Payload |
|---|---|
| 1 HEADERS | JCS `{status,headers}`; status is an integer 200–599 |
| 2 DATA | 1–65,536 raw bytes, also subject to aggregate response limit |
| 3 TRAILERS | JCS `{headers}` with declared name/Base64-value pairs |
| 4 END | Zero bytes |
| 5 GATEWAY_ERROR | JCS `{code,request_id,operation_id}`; known identities or null before admission |

Metadata frame length is 1–65,536. Name/value limits apply after Base64 decoding;
reject invalid/noncanonical Base64. Valid sequences are `GATEWAY_ERROR EOF` or
`HEADERS DATA* TRAILERS? (END | GATEWAY_ERROR) EOF`; DATA is forbidden for
HEAD/204/205/304. Unknown tags, duplicate metadata, data after trailers, premature
EOF, invalid payloads and bytes after terminal frames are protocol errors. Read
length bounds before allocation. Trailers/completion promises reject on failure.
END means a complete HTTP carrier, even when meter evidence remains unknown.

Before framing, local gateway errors use a bounded JSON error and appropriate
outer status. Codes include `invalid_envelope` (400), `unsupported_capability`
(400), `unsupported_metering` (400), `request_too_large` (413), existing identity/
recovery errors (409), `budget_exhausted` (402), `concurrency_limit` (429),
`adapter_unavailable` (503), `upstream_transport_error` (502),
`response_policy_violation` (502) and `execution_timeout` (504). Code and identity
are the complete error payload; never echo headers/query/body/provider errors.
Post-dispatch errors use a terminal frame or abort, then normal status recovery.
No HTTP status, including 4xx, is a blanket promise of nonexecution or safe retry.

## Receipt v3 and persistence

Keep every field of the current
[ReceiptBody](../../services/control/src/receipts.rs) and add exactly:

```text
binding_hash, operation_hmac, meter_hash, resource, completion
meter_hash = SHA256(JCS(binding.meter))
completion = null | {rule_hash, outcome:"satisfied"|"not_satisfied", http_status}
rule_hash = SHA256(JCS(binding.completion))
```

`resource` equals binding.meter.resource. `http_status` is an integer 200–599;
it cannot be null inside a completion object. V3 is proxy-only:
operation_id is non-null and provider_reported_usd is null. Hash/sign the whole
body using the existing receipt key and receipt algorithm. The ledger, signer,
SDK, native verifier and WASM verifier enforce the following exact variants:

| reason / evidence_kind | usage and completion | Amounts |
|---|---|---|
| `metered` / `PROXY_USAGE` | Every tariff unit exactly once in ASCII order, explicit zeros; completion non-null | Observed C; charge min(C,R); loss C−charge |
| `not_dispatched` / `NOT_DISPATCHED` | `[]`, completion null, provider request/evidence null | Observed/charge/loss `"0"` |
| `waived_unknown` / `UNKNOWN_OPERATOR_LOSS` | `[]`, completion null | Observed/loss null; charge `"0"` |
| `late_usage` / `PROXY_USAGE` | Complete unit vector and completion, linked original receipt | Observed C; charge `"0"`; loss C, as existing late-observation semantics |

Fixed `requests` is exactly 1 iff completion is satisfied, otherwise 0. Usage
meters compute amounts from counts even for a failed completion. A signed
charge receipt is unique and immutable; late_loss_observation must link the
original receipt and never changes settlement. Late observations are evidence,
not extra customer debits or a sum to add repeatedly to provider invoice costs.
`provider_evidence_digest` may hash only bounded prompt-free normalized evidence;
never put an unkeyed response/prompt fingerprint or a secret handle in a receipt.

Compare binding/tariff/meter/resource/rule hashes with the original quote, and
operation_hmac with the saved operation. The SDK retains that MAC after request
redaction; the signer checks the ledger's immutable commitment. A valid receipt
signature alone does not excuse an identity or arithmetic mismatch. Unknown
evidence is not a fabricated measured-zero vector.

Use additive version columns/nullable fields and v3-only constraints in the
existing ledger and signer verification. Keep historical tariffs, receipt bytes,
operation endpoints and claims intact. NoteJournal schema 3 adds a discriminated
v2 invocation plus saved commitment; sent entries contain no envelope/body/query/
header values. EncryptedRecord schema 1, custody and wallet transport attempts
are unchanged. Read old schema 1/2 journals without rewriting their signed bytes.

Schema 3 also permits `gatewayRecoveryHold:{request_id,operation_id,delivered}`.
This delivery marker references the existing authorization and sent v2 operation;
it contains no financial state. The same durable write that redacts a sent request
pre-arms the hold with `delivered:false`. All new local inference/API calls are fenced before
UUID allocation or authorization while delivery remains uncertain. A clean END
and outer EOF, successful local delivery and a verified metered receipt whose
completion is satisfied are required for automatic release. A delivered successful
operation may wait up to 45 seconds using only close/status/receipt observation.
The native runtime requires a private acknowledgement from the Go frontend after
the outer HTTP response, including final chunk/trailer framing, has been flushed
without write errors. Completion of the internal Unix-socket response alone does
not mark delivery. This establishes successful local socket writes, not proof that
the caller application consumed the response. A missing acknowledgement leaves
the durable hold intact.
Background settlement, an unknown waiver or restarting the daemon cannot release
an uncertain hold. Explicit management recovery may release it only after the
original authorization closes and no emergency escape remains unresolved.

## Implementation and acceptance

The source implements shared validators, tracked JSON schemas and vectors,
Rust/SDK/native/WASM verification, additive ledger and journal records,
dispatcher/carrier, lossless SDK/native bridges and registration/profile
capability negotiation. `work/design/generate_contracts.py` generates the source
OpenAPI alongside the implemented endpoint. Published packages and deployed
capabilities remain separate; see [support status](../support.md). Existing
financial ownership and no-replay rules apply at every step.

Schema 3 profiles retain schema 2's authenticated selection/trust fields and add
required `gateway:{capabilities:["finite_http_v1"],mounts:[{prefix,service,
operation,binding_hash}]}`. Services remain `{tariff}` entries. Mounts are explicit,
sorted by prefix/service/operation and subject to the design's collision rules;
there is no automatic routing from the catalog. SDK-version membership and
installed capability pins must match before custody/AUTH. A browser must declare
its lossless transport subset; no blanket browser capability is implied.
Gateway-only profiles use `models:[]` and `modelCapabilities:{}`. Local
`/v1/models` derives entries from authenticated, explicitly mounted
`services[].tariff.api.meter.resource` selections, not duplicate legacy model
tariffs. Reject ambiguous model IDs across providers/bindings on one mount.
Mixed legacy/gateway profiles must have disjoint routes and explicitly scoped
model discovery; they cannot change a funded profile's selection.

Required vectors include empty/binary bodies, percent-escape spelling, duplicate
query/header values and ordering, credential removal, all ten HMAC parts,
fixed measured-zero versus unknown, mixed rational rates and cap overflow. Mutate
each committed input and require a different MAC; header-name case/inter-name
ordering changes alone normalize to the same MAC. Legacy golden vectors must
remain byte-identical. Frames require truncated prefixes/payloads, excessive
lengths, missing END after exact content length, 205 and absent/forbidden trailers.
Compressed SSE/JSON fixtures verify actual native Accept-Encoding values, raw
byte preservation, final decoder validation, expansion limits and usage equality
with the corresponding identity response.

Extend the existing fresh-checkout synthetic-provider lifecycle and installed SDK/
native acceptance, using isolated custody under ignored `target/`. Require
deposit = withdrawal + signed charge for success, unknown, duplicate ID,
disconnect and restart, and exactly one upstream business dispatch in each
attempted-operation case. Run actual native clients through this complete path;
the existing protocol-only probes are insufficient. Real proof/SBF, synthetic
HTTP, offline schema/vector checks and CI remain separately labeled evidence.
