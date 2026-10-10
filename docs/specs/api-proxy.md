# API, proxy and settlement contract

Control APIs use `/zkapi/v1`; inference APIs use `/v1`. Supported designs are
`direct_oa`, `direct_openrouter` and provider-specific proxy sessions. See
[OpenAPI](../contracts/openapi.json) for types/routes,
[ledger.sql](../contracts/ledger.sql) for durable state and
[support status](../support.md) for verified deployment scope.

## Client lifecycle and credentials

1. Deposit USDC using a locally generated tree proof and authenticated transport;
   obtain the finalized root and note path.
2. Request a quote for provider, mode, models and tariff.
3. Generate request UUID, control secret and, for proxy mode, proxy secret with
   the device CSPRNG; durably journal them.
4. Generate a request proof bound to the quote and credential hashes. Do not send
   the secret note or wallet address to the control API.
5. Authorize with `POST /zkapi/v1/sessions`. Direct keys are delivered only in the
   first creation response; proxy uses the client's own token.
6. Run inference within the cap. Expiry/close stops new admission and starts settlement.
7. Retrieve and verify charge, successor commitment/anchor, blind delta and state
   signature before updating the journal.
8. Start the next authorization or withdraw. Never advance one note twice concurrently.

Control and proxy secrets are independent random 32-byte values, encoded as
43-character unpadded base64url. Hash raw bytes with SHA-256 and compare in
constant time.

| Token | Purpose |
|---|---|
| `zkc1.<request_uuid>.<secret43>` | Session creation, status, close, recovery and operation status |
| `zkp1.<request_uuid>.<secret43>` | Inference only |

Bodies contain credential hashes only. Put full tokens in authentication headers,
never URL/query/cookies. Proxy accepts OpenAI Bearer or Anthropic x-api-key,
rejecting simultaneous headers. It substitutes operator credentials upstream;
client tokens are never forwarded. Proofs bind mode, UUID and both credential
hashes so an intercepted proof alone cannot recover keys or settlement details.
Lost credentials require the client's encrypted backup; wallet-signature recovery
must not link ordinary authorization to deposits.

## Quotes and canonical authorization

QuoteBody is UTF-8 RFC 8785 JCS; SHA-256 excludes quote_hash and signature. Amounts,
times and integer versions use decimal strings, never JavaScript Number.
Reject duplicate keys, invalid UTF-8 and unknown fields. Array order is meaningful;
models are ASCII-sorted and unique.

```text
QuoteBody:
quote_id, deployment_id, pool, mode, provider, models[], tariff_hash,
cap_micro_usdc, issued_at, expires_at, session_ttl_seconds, max_concurrency,
control_api_origin, inference_api_origin

AuthorizationBody:
version:"1", deployment_id, pool, request_id, quote_hash, mode,
control_secret_hash, proxy_secret_hash
```

Allowed pairs are direct_oa/oa, direct_openrouter/openrouter and
proxy/{openai,anthropic,openrouter}. Check catalog endpoint/model support.
Direct uses `models=["*"]` and provider-enforced permissions; zkAPI cannot enforce
restrictions absent from the upstream key. Proxy quotes bind one concrete model.
Direct proxy_secret_hash is null. JCS AuthorizationBody supplies authorization_bytes
for H2F; it contains neither prompt nor prompt hash.

Persist quotes. The manifest-pinned Ed25519 quote key signs raw quote_hash32,
separately from Baby-JubJub state/clearance keys. SDKs verify signature, origins,
pool and tariff before proving. Initial profile: quote lifetime 120 seconds,
session admission 60 seconds configurable within 1–300, proxy concurrency 4,
solvency_bound=pool cap=1,000,000 micro-USDC. A balance below the fixed cap can be
withdrawn. clientd key reuse=0 closes after one request, not a zero-lifetime key.

Authorization order:

1. Check <=16 KiB size, syntax, control token, deployment, saved/signed quote,
   authorization tag and fixed public inputs.
2. Look up `(pool,N)` and `(pool,request_id)`. An identical body/proof/input digest
   returns the saved result; a different digest returns 409. Do not reapply quote
   expiry or root freshness to already accepted requests.
3. For new requests, require unused/unexpired quote, RP.request_time=quote.issued_at,
   correct cap/state key, current finalized root and valid proof. Unknown root
   gives 503; stale root gives 409 and requires a new quote/proof.
4. Check ExitNullifier through primary and secondary RPC. An exit or observed
   unfinalized escape blocks admission; unknown state gives 503.
5. Under the writer transaction, recheck reservations. After locking, use
   `clock_timestamp()` to recheck quote expiry (equality is expired), pool admission
   and unused quote. Revalidate changed/expired root observations; unknown gives
   503. Atomically reserve N as AUTH, save transcript and consume quote once.
   If another request won, return to step 2.
6. Recheck exits immediately before key issuance/proxy activation and before
   returning a direct key. An observed escape stops new usage and hands saved
   authorization evidence to the challenger.

Digest is SHA256(JCS(SessionCreate)); retries retain every field and exact proof.
Before replacing an unaccepted proof, check N's acceptance state, then use a new
request ID, credentials and quote.

## Session state and signing

```text
RESERVED -> ISSUING -> ACTIVE -> DRAINING -> RECONCILING -> SIGN_PENDING -> SETTLED
              |
              +-> ISSUANCE_UNKNOWN
```

Proxy may skip ISSUING. Fix expiry at the first ACTIVE transition. Close/expiry
persist close_requested=true idempotently. Close during issuance waits for its
outcome, then disables and settles without returning a key. DRAINING accepts no
new operations; SETTLED is immutable. Never replay inference automatically.

| Transition | Required condition |
|---|---|
| RESERVED→ACTIVE | Proxy, no close request, exit rechecked |
| RESERVED→ISSUING | Direct, no close request, issuance intent durable |
| RESERVED→RECONCILING | Confirmed no issuance after close/admission stop; charge=0 |
| ISSUING→ACTIVE | Key ID saved, no close request, exit rechecked |
| ISSUING→ISSUANCE_UNKNOWN | Timeout/lost response with unknown key existence |
| ISSUING/ISSUANCE_UNKNOWN→DRAINING | Key existence confirmed; disable and inspect usage; never issue a replacement |
| ISSUING/ISSUANCE_UNKNOWN→RECONCILING | Nonissuance confirmed; charge=0 |
| ACTIVE→DRAINING | Close, expiry, exit observation or provider stop |
| DRAINING→RECONCILING | Admission stopped; direct key disabled or proxy operations terminal/unknown |
| RECONCILING→SIGN_PENDING | Usage/waiver fixed, reservations zero, operations terminal, attempts finished/fenced, unique charge chosen |
| SIGN_PENDING→SETTLED | Signature for saved target verified and stored |

Use row locks and compare-and-set against the prior state; no other backward
transitions. Preserve state across outages. Never release N reservations, even
when issuance is confirmed absent: sign one zero-charge successor and advance
anchor. Unknown issuance is not absence. Direct adapters confirm disablement,
provider-specific usage capture and deletion before settlement.

Hold a direct creation HTTP response until its initial key delivery. Connection
loss, response deadline or a 202 before that delivery persists close_requested;
late successful issuance drains without returning the key. After a crash that
cannot establish delivery, never redeliver. Recovery of a direct session whose
client journal lacks the key sends idempotent close and waits for settlement.
GET status remains read-only. Proxy 202 responses may be polled for activation.

### Single writer and signer journal

A dedicated PostgreSQL connection holds the per-pool advisory lock and executes
all financial transactions. Route mutations through that writer and lock session
rows `FOR UPDATE`. Losing the connection/lock immediately stops authorization
and signing. Read replicas and databases under restore cannot authorize signing.
Do not rely on monitoring a lock connection while separate connections write.

Increment writer_epoch after acquiring the lock; reconcile recovery before
admission. Quotes, sessions, operations, settlements, clearance and receipts all
use this writer. Signer/dispatcher do not mutate financial rows independently.
External-send fencing follows [operations](operations.md).

While holding a RECONCILING row lock, insert settlement and CAS to SIGN_PENDING
in one transaction. Persist charge, fresh anchor, blind delta, E_next and exact
signing bytes once. The isolated signer reads the primary ledger, rechecks
terminal operations, zero reservations and finished/fenced attempts, and rejects
a different message for an existing authorization. Publish signatures only after
saving them. Recovery may retrieve/sign only the same saved message; do not run
uncontrolled workers holding the signing key.

The signer journal is independent of ledger restore. Before signing, atomically
persist unique `(pool,N)`, AUTH/CLEARANCE role, AUTH request ID, role-specific key
and exact message/digest. Request ID alone is insufficient after database rollback.
Reject changed role, request or message; save signature before returning it.
Missing/different ledger targets or signed ledger records without journal entries
stop admission/signing for reconciliation. An unsigned prepared target may have
no journal yet; an existing unsigned intent may be signed only for that same
target. Recover saved journal signatures into the ledger. Never recreate a lost
journal as empty. These rules also apply to clearance.

`POST /zkapi/v1/withdraw/clearance {nullifier}` shares the `(pool,N)` lock with
AUTH. Existing AUTH returns 409; existing CLEARANCE returns the same signature.
Permanently reserve unused N as CLEARANCE before signing the original
clearance_message. Treat N as a secret-derived capability without wallet identity;
rate-limit and exclude it from access logs. This is the original clearance rule,
not an unconditional refund operation.

## Proxy operations and reservations

Require `Idempotency-Key: UUIDv4`; clientd/SDK generate and retain it. Session plus
operation ID is unique. Body digest is:

```text
key = SHA256(ASCII("zkapi-proxy-body-v1") || proxy_secret_raw32)
body_hash = HMAC-SHA256(key, frame("solana-zkapi-operation-v1", [
  method_ascii, path_ascii, anthropic_version_ascii_or_empty, raw_body_bytes
]))
```

Use protocol framing, POST, fixed query-free route and identity-encoded UTF-8
body. Anthropic version applies only to Messages/count_tokens. Changed endpoint,
version or bytes conflict, even for semantically equivalent JSON. Never persist
plain prompt hashes, provider credentials or request/response bodies.

```text
RESERVED -> DISPATCHING -> STREAMING -> METERED -> DONE
                    \-> USAGE_UNKNOWN -> METERED or WAIVED_OPERATOR_LOSS
```

Under the session lock, new admission checks ACTIVE, no close request,
`extract(epoch from clock_timestamp()) < expires_at` after locking, provider/model/
endpoint, concurrency and budget. Do not use transaction-start `now()` or rely on
expiry timers. Recheck stop conditions immediately before dispatch CAS; unsent
RESERVED operations after close/expiry finish with zero charge. Control-token
status remains available after expiry.

Nonstream responses may move DISPATCHING→METERED. Post-send uncertainty, including
streaming, becomes USAGE_UNKNOWN. Persist DISPATCHING and dispatch_attempts together
before sending. Once a send is possible, only inspect that same upstream execution;
never automatically retry inference. Status returns metadata, not response bodies.
Same-ID/body repeats return 409 `operation_in_progress` while running or
`response_not_replayable` with status URL after completion. Changed bodies return
409 `idempotency_conflict`. Do not silently choose a new ID.

If a lost worker's operation remained RESERVED and never committed DISPATCHING,
nonexecution is established: release the reservation, finish with charge=0 and
retain `not_dispatched` audit metadata. This differs from post-dispatch uncertainty.

### Cost bounds

Direct tariffs use `pricing_basis=provider_reported_usd`, rates=[] and model="*".
They aggregate provider usage across models and fix conversion at 1 USD=1 USDC
plus cap; they do not freeze provider token prices. Proxy binds one provider/model
and `fixed_usage_rates` tariff hash. Changing models requires settlement and a
new quote; multi-model proxy would require a separately versioned tariff binding.

1. Adapter derives maximum cost R from input bound, output limit, allowed tools
   and tariff. Inputs without a provable bound return 400 `unsupported_metering`.
2. Under the session lock require
   `charged_nano + reserved_nano + R_nano <= cap_micro * 1000`.
   Accumulate integer nano-USDC using u128/NUMERIC(38,0).
3. Save reservation and operation before dispatch. On completion calculate C,
   release R and absorb any C>R as operator loss.
4. Sum charged nano across the session and round once with
   `ceil(sum_nano/1000)` to micro-USDC. Never round each operation to micro first;
   recheck charge<=cap.

Validate token-count API costs and bounds; an unverified tokenizer estimate cannot
justify exceeding a cap. Conservative provider-context bounds are allowed but
must fit the cap before dispatch. Use exact tariff ratios and round finer values
up to nano once per operation. Supported rates cover input/output/cache-read/
cache-write. Avoid double-counting inclusive usage; hide models with unsupported
fees, dynamic prices or hosted-tool charges. Version and time-bound tariffs,
keeping accepted sessions on their original tariff.

### Streams and unknown usage

Relay SSE and read through final usage even after client disconnect. Do not log
bodies. Keep provider request IDs for usage lookup; cancellation is best effort
and does not guarantee zero cost. Each operation has a 600-second hard deadline,
then USAGE_UNKNOWN. Ending session admission does not settle unfinished work.

Target resolution within 900 seconds of each DISPATCHING commit. First confirm
the sending owner finished or was fenced. If usage remains unavailable, fix
`WAIVED_OPERATOR_LOSS` at charge=0; this does not assert nonexecution. Reject
new use of expired tokens and redispatch. Sign the successor once, and append
late operator-loss observations without changing signed charges.

Without confirmed fencing, hold RECONCILING, stop admission and alert; the
900-second target no longer applies. A database flag alone cannot stop sends.
This proxy waiver does not automatically apply to direct sessions whose key was
given to a user. Excessive unknown usage/loss stops that provider's new admission.
Normal charges expose request ID, usage, tariff hash and arithmetic. A proxy
signature authenticates the operator's record, not provider computation in ZK.

## Provider adapters and API scope

```text
validate(request, catalog) -> normalized_request | unsupported
reserve_bound(request, tariff) -> nano_usdc
dispatch_once(operation_id, request, service_credential) -> stream + provider_request_id
observe_usage(stream) -> usage | unknown
lookup_usage(provider_request_id) -> usage | unavailable
cancel(provider_request_id) -> confirmed | unknown | unsupported
calculate_charge(usage, tariff) -> nano_usdc
```

Direct adapters provide create_restricted_key/disable/read_usage/delete/
verify_receipt. OA issuer-signed receipts and OpenRouter management observations
have different evidence classes. Preserve authentication and issuer/verifier pins;
verify advertised paths with real permissions.

| Endpoint | Upstream | Contract |
|---|---|---|
| GET /v1/models | Manifest/catalog | Enabled models; rates/modes available through control catalog |
| POST /v1/chat/completions | OpenAI/OpenRouter | Text, client function calls, nonstream/SSE; internally required usage |
| POST /v1/responses | OpenAI | Text, client function calls, nonstream/SSE; store=false; reject previous_response_id/background |
| POST /v1/messages | Anthropic | Text, client tool_use/tool_result, nonstream/SSE, usage/cache categories |
| POST /v1/messages/count_tokens | Anthropic | Only supported safe-estimate catalog entries; authenticated and rate-limited |

count_tokens initially charges/reserves zero for users, with invocation limits;
operators pay any upstream cost. Its result is not billable inference usage.

Do not automatically translate arbitrary provider formats. OpenRouter may expose
Claude models under its own IDs; Anthropic format uses the native Anthropic
adapter. Construct only allowlisted upstream headers, excluding client tokens,
management keys, cookies, forwarding IPs and arbitrary headers. Check Origin/Host,
limit bodies to 1 MiB and pin DNS/redirect destinations against SSRF.
Rate-limit by anonymous session, cap and short-lived salted IP keys; do not build
an IP-to-wallet mapping. Timing/body/network correlation remains possible.

## SDK, clientd and indexer

[Tree transition](tree-transition.md) defines local prepare/prove/verify/encode.
SessionCreate never gains tree proofs or note IDs. Only chain tree updates require
tree proofs; finalize does not. Manifest pins layout, backend, tag policy, profile
and all three circuit artifacts. Verify signed manifest, PK/VK hashes and actual
PoolConfig before use. `v0_buffer` is mandatory; additional authenticated formats
follow their contracts, including [compact deposit](compact-deposit.md). Match the
[machine wire contract](../contracts/tree-transition.json).

Native proving is required; measure browser-worker latency/memory and validate
all remote-worker outputs locally against fixed VK/expected inputs. Workers need
no secret note or authorization session data. Do not make a central proving
service an exit dependency. Proving does not reserve state; journal conflicts
and unknown sends under the tree contract.

- SDK: note creation, deposit/finality, quotes, authorization, proxy/direct
  sessions, close/recovery and withdrawal/escape/challenge status share the
  existing clients and encrypted storage. Browser proofs use a worker.
- clientd: defaults to `127.0.0.1:8787`; inference and wallet administration use
  separate credentials. Distinguish provider keys from proxy tokens; mode is
  explicit and direct never silently falls back to proxy.
- Journal: durably distinguish unsent, unknown, accepted, active, settlement
  pending and signature-verified states using fsync/transactions. Do not erase
  old state before saving its successor or add identifying backup metadata.
- Indexer: replay finalized execution order; snapshots include pool, slot,
  blockhash, sequence, root and next ID. Reconstruct missing events from history
  and stop serving paths on disagreement.
- Paths: support Active membership, next-note zero and Pending restore-zero paths.
  Public note IDs stay outside ordinary authorization.
- Tor/SOCKS5: remote DNS and fail-closed routing. Verify direct/proxy/indexer/RPC
  routes separately; partial routing does not establish anonymity.

`GET /zkapi/v1/nullifiers/{nullifier}` returns only unused/authorized/cleared/
exit_consumed/unknown, never request ID, charges, proofs or credential hashes.
Rate-limit it; RPC failure is not unused. Detailed recovery requires a control token.

Private dashboard routes `/admin/v1/dashboard/summary`, `/recent` and `/events`
require a separate listener, admin Bearer credential and network ACL. Summary
contains aggregates, failures, settlement amounts and root/slot lag; recent/events
contain transitions without bodies, IPs or keys. Monitoring access grants no
signing or provider-key authority.

## Errors

Control envelope:
`{error:{code,message,retriable,request_id,retry_after_seconds,latest_root}}`.
Messages exclude proofs, tokens and payloads. Use 400 invalid/unsupported, 401
credentials, 402 budget, 409 conflict, 410 expired, 413 size, 429 rate limit and
503 unavailable. `retriable=true` permits the same operation's safe query/retry,
not inference with a fresh ID.

Inference uses provider-compatible envelopes plus `X-Zkapi-Error-Code`.
After a stream starts, send its error event and close rather than changing HTTP
status. Success and accepted-operation 409 responses include
`X-Zkapi-Operation-Id` and
`X-Zkapi-Status-Url: /zkapi/v1/sessions/{request_id}/operations/{operation_id}`.
Sanitize provider errors for credentials and identifying data.

## Tariffs and exact metering

TariffBody excludes only tariff_hash; SHA256(JCS(TariffBody)) defines it and SDKs
recompute it. Rates are ASCII-sorted by unique unit. Versions, times, numerators
and denominators are canonical decimal strings. Require denominator>=1 and
`valid_from <= quote.issued_at < valid_until`; accepted sessions keep the tariff
after expiry.

Units are input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
cache_write_5m_tokens and cache_write_1h_tokens. A single cache-write rate cannot
coexist with 5m/1h rates. Proxy requires input/output and all potentially charged
cache units; provider/model must match quote. Direct permits oa/openrouter,
model="*", rates=[]. `operator_fee_micro_usdc="0"`.

Counts and rate numerators are 0..2^63−1; denominators 1..2^63−1; at most six rates.
Use arbitrary-precision rational intermediate arithmetic and verify rounded values
fit NUMERIC(38,0). Overflow/unknown units mean unknown usage, never estimated
billing. Reject unbounded reservations before sending.

```text
observed_nano = ceil(sum(count_i * numerator_i / denominator_i))
charged_nano = min(observed_nano, reservation_nano)
operator_loss_nano = observed_nano - charged_nano
session_charge_micro = ceil(sum(charged_nano) / 1000)
```

Round the rational sum once per operation, not each rate term. For direct usage,
parse selected USD strings/JSON numeric lexemes as exact decimal rationals, sum
models, round USD×10^9 upward once to nano, cap at cap_micro×1000 and round upward
to micro. Never use binary floating point.

Normalized usage is an ASCII-sorted, unique array of unit/count pairs. Missing
usage is not zero. Subtract cache counts from inclusive OpenAI input; do not add
Anthropic's separately reported cache units back into billable input. Separate
5m/1h writes, avoid duplicate reasoning-output charges and do not sum cumulative
SSE totals across frames. Pin provider/model/API mappings, zero-if-missing fields
and supported cache classes in fixtures; unverified categories stay out of catalog.

### Direct OpenRouter capture policy

Capture exact management `usage + byok_usage` after confirmed key disablement and
the configured grace period. Persist that observation before deletion; confirm
deletion before signing the capped settlement. Missing, malformed or unavailable
usage is not zero. Ambiguous deletion remains pending and reuses the saved amount;
never issue a replacement key or replay inference. Never reprice a settled session.

Grace is an operator assumption about in-flight work and accounting delays, not
proof of a final invoice. Delayed/unobserved costs remain the operator's risk.
operator_loss_nano_usdc measures only this observation's excess above the charge.
Late observations may append operator-only loss records. OA issuer-finalized
receipts and proxy metering keep their own rules. Upstream default grace/poll
intervals are five/two seconds; deployed settings are explicit operator choices.

## Signed receipts

`GET /zkapi/v1/sessions/{request_id}/receipts` requires a control token and returns
cursor-paginated signed receipts. Terminal OperationStatus requires a receipt,
distinguishing zero charge and waiver. Direct creates one session receipt with
operation_id=null. No bodies or raw provider keys are included.

OpenAPI defines ReceiptBody. `receipt_hash=SHA256(JCS(ReceiptBody))`; the separate
manifest-pinned Ed25519 receipt key signs raw hash32. Bind request/pool/deployment/
operation, tariff, reservation, selected USD, provider request ID or null, usage,
observed/charged/loss nano, reason and evidence class. A proxy signature is the
operator's statement, not an OA receipt or provider proof. provider_evidence_digest
is the digest of the original verified/observed record, or null if unavailable.

Metered direct receipts use exact selected USD in non-exponential canonical
provider_reported_usd (no unnecessary leading/trailing zeros, <=128 characters),
usage=[] and reservation_nano_usdc=cap_micro×1000. OpenRouter's selected USD is the
management capture above, not final-invoice assurance. Proxy sets USD=null and
reservation=R. Unissued/unknown direct usage uses USD=null, distinct from observed
zero. These fields let clients recompute both direct and proxy charges.

`billing_effect="charge"` is unique and immutable per operation, or per direct
session. Before SETTLED, sign/save all charge receipts and compare their summed
charged nano, rounded to micro, with settlement. Unknown receipts have null
observed/loss amounts and zero user charge. Late usage appends
`billing_effect="late_loss_observation"`, user charge=0 and the original hash in
related_receipt_hash; never edit original receipts or successor signatures.
Cursors follow storage order and are session-scoped. Required verification and
arithmetic fields cannot be hidden in freeform metadata.

Publish DONE/WAIVED atomically with the signed receipt. A pending unsigned earlier
receipt blocks cursor advancement past it. Empty usage with null observation and
reason distinguishes unknown from measured zero.
