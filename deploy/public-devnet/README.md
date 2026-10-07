# Public Devnet operator preparation

Status: public preview deployment in progress. On 2026-10-08 JST the user
approved the [roughly USD50/month US East plan](aws-budget-host.md) and the
AWS-generated CloudFront HTTPS hostname. Long-term operation qualification is
outside the current requested scope. The earlier USD100/seven-day proposal is
superseded. The additional seven-USDC provider exposure approval remains valid
for one seven-cap authority. Actual provisioning, public acceptance and authority
initialization outcomes are recorded separately; preparation alone does not
close PD-01, PD-04, PD-05, PD-06 or PD-10.

The four inherited setup files now have an exact-hash Apache-2.0 redistribution
review based on the original author’s root README declaration. See the
[follow-up](../../docs/evidence/PD-02-redistribution-followup.md) and
[notice packaging](../../docs/evidence/PD-02-notice-packaging.md). The earlier
permission uncertainty is resolved for those bytes. A
[complete bundle with notices](../../docs/evidence/PD-complete-bundle-notices.md)
and [six fresh matching native/WASM proofs](../../docs/evidence/PD-complete-bundle-proofs.md)
passed local packaging and independent verification. Anonymous public downloads
and actual browser/public-service acceptance remain separate checks.

## Admission suspension without disabling recovery

The bounded relay accepts an optional `allowNewAdmissions` boolean. Omission
preserves its historical behavior. For maintenance or exhausted subsidy, set
`allowTransactions: true` and `allowNewAdmissions: false` in a new reviewed
configuration using the existing deployment, ledger and journal identities.
Do not restart or replace an existing deployment merely to apply this example.

| Operation while new admission is suspended | Behavior |
|---|---|
| New direct AUTH reservation | Refused under the existing durable budget lock |
| Identical previously reserved direct AUTH | Exact request ID, SHA-256, template and cap remain required; re-fsynced before forwarding |
| Changed bytes for a reserved AUTH | Refused, even when semantically equivalent |
| New compact deposit or buffer deposit creation | Refused before transaction forwarding |
| Existing upload append/seal/execute/close | Existing signature/program/Pool/fee guards remain; completion of an already created buffer is possible |
| Session status, receipts, close and withdrawal clearance | Remain routed with existing authentication and validation |
| Escape creation and finalization | Remain routed with existing signed transaction checks |
| Proxy inference | Refused; this option does not replay an earlier response |

`allowTransactions: false` remains the global write stop and intentionally
blocks recovery writes too. It is unsuitable as an admission-only maintenance
switch. Admission suspension cannot revoke already issued direct provider keys;
existing sessions still require their normal stop, usage collection and signed
settlement lifecycle. The historical proxy fixture has no exact AUTH reservation
recovery facility, so suspension also blocks its AUTH route. The new recovery
behavior above is specific to the bounded direct OpenRouter path.

The existing parent campaign remains immutable. It has 17 reservations totaling
9,154,216 micro-USDC, with 845,784 remaining at the latest recorded handoff; that
cannot admit another full 1,000,000-micro-USDC direct authorization. Re-read the
authoritative private ledger before any deliberate funded run. Neither this
configuration nor a user holding Devnet tokens grants a new provider-spend
budget. The helper cannot initialize/reset a campaign, refund reservations or
retry inference. Its `--no-new-reservations` option only permits exact reserved
AUTH recovery and is not available on another command.

The selected AWS deployment uses the separate
[detached V2 seven-cap authority](detached-budget.md), covered by the received
seven-USDC provider approval. It transfers no original remainder and links only
to a root-owned read-only historical snapshot. AWS status counts its active
7,000,000 micro-USDC and seven slots; it does not report a live combined balance.
Old AUTH recovery stays with the existing local authority. V2 recovers only its
own exact reserved AUTHs. The earlier [V1 local-lock supplement](supplemental-budget.md)
remains an alternative implementation, but the same approval must never
initialize both authorities or two copies of either grant.

## Public-profile API gateway

`scripts/public_devnet_gateway.ts` loads the new authenticated public SDK
profile and complete bundle from operator-installed public files. It reuses
`loadPublicDeploymentProfile` for exact profile/descriptor/artifact/WASM hashes,
manifest trust and model bindings. Loading is offline: no chain/provider call,
wallet, UI checkout, custody creation or budget initialization is involved.
Startup then validates the explicitly initialized private budget selection and
binds only `127.0.0.1`.

Run with a private owner-only configuration:

```sh
node scripts/public_devnet_gateway.ts --config /private/gateway.json
```

The strict configuration fields are:

| Field | Purpose |
|---|---|
| `port`, `publicOrigin` | Loopback listener and exact operator-owned HTTPS origin |
| `allowedBrowserOrigins` | Explicit HTTPS application origins; no wildcard/reflection |
| `allowNativeRequests` | Explicitly allow clients without Origin and either no Fetch Metadata or only Node fetch's `Sec-Fetch-Mode: cors` |
| `allowTransactions`, `allowNewAdmissions` | Global write and separate new-admission policy |
| `admissionTokenSha256` | Operator-private SHA-256 of canonical invitation text; required when new admission is enabled |
| `profileUrl`, `profilePath`, `profileSha256` | Public canonical URL, locally installed profile bytes and independently authenticated exact digest |
| `bundleDescriptorPath` | Locally installed descriptor; every referenced flat public asset is beside it |
| `rpcUrl`, optional `historyRpcUrl` | Private HTTPS upstream RPCs; never included in public responses |
| `indexerUrl`, `controlUrl` | Fixed upstream service origins; HTTPS or numeric-loopback HTTP |
| optional `localCaPath` | Existing local service CA; never disables verification or changes public TLS trust |
| `budget` | Selected AWS `supplemental-detached-v2` authority and snapshot pins; see [the exact configuration](detached-budget.md#gateway-and-service-confinement). Legacy `planPath`/`stateDir`/`caseId` and local `supplemental-v1` selections remain supported for their own authorities. |

All booleans are explicit. Public new AUTH requires an invitation in addition to
the normal protocol checks and durable budget. Generate 32 cryptographically
random bytes and encode them as unpadded base64url (exactly 43 characters). Set
`admissionTokenSha256` to the lowercase SHA-256 of that UTF-8 token text, not the
decoded random bytes. Keep the token out of public profiles, static assets, URLs,
logs and persisted browser state; distribute it separately to invited testers.
The browser sends `x-zkapi-admission` only on exact session AUTH POSTs. The gateway
checks the digest in constant time, strips the invitation from upstream traffic,
and never includes either token or digest in diagnostics. Missing/invalid tokens
cannot create a new reservation or forward a previously unreserved AUTH. Identical already reserved
AUTH recovery remains available without an invitation; changed bytes still fail.
Other routes refuse the invitation header. The shared invitation is a preview
access gate, not per-user accounting; the selected immutable budget is the
hard spend limit. Token rotation must preserve exact reserved AUTH recovery
within that authority.

`publicOrigin` must match the authenticated manifest's
control origin and profile's indexer origin; profile RPC must be exactly
`publicOrigin + "/rpc"`. This initial gateway supports one reviewed OpenRouter
Chat model, direct provider base `https://openrouter.ai/api/v1`, and the existing
1,000,000-micro-USDC cap/campaign contract. It does not silently translate proxy,
OA, multi-model or differently capped profiles. Unsupported profiles fail before
a listener starts. Historical `.invalid` identities and local reference-app
profiles are not used by this gateway.

Canonical routes are `/zkapi/v1/config`, catalog, attestation, the reviewed tariff,
quote, session AUTH/status/close/receipts/operations, withdrawal clearance,
`/zkapi/v1/tree/root`, both shared snapshot routes, and `/rpc`. The existing
method, credential, exact AUTH, signature/program/Pool/fee and budget checks stay
in place. Selected-note queries, arbitrary upstream destinations, old `/control`
and `/indexer` prefixes, provider inference and application files are refused.
The independent application serves its own worker and static files. Publish the
profile and complete bundle on a separately reviewed immutable static host whose
CORS permits the intended app origins; the gateway never serves private files.

Browser requests require an explicitly allowed Origin. OPTIONS checks the exact
route/method and allows Authorization and Content-Type request headers.
CORS never permits cookies or ambient credentials. The extra
`x-zkapi-admission` request header is allowed only for session AUTH preflight. Same-origin browser fetches that omit
Origin require the gateway origin in the allowlist and matching same-origin
Fetch Metadata. A native request without Origin is accepted only when explicitly
enabled and when Fetch Metadata is absent or consists solely of Node fetch's
`Sec-Fetch-Mode: cors`. Any site, destination, user or additional Fetch Metadata
header excludes that native branch. The [focused public verification](../../docs/evidence/PD-gateway-node-fetch.md)
records the actual Node compatibility fix and retained browser-origin guards. Cookie, API-key,
proxy-authorization and forwarded-origin overrides are rejected. Origin checking is a browser transport policy, not protection against clients
that can send arbitrary headers. The separate invitation, durable budget and
normal session credentials remain mandatory. Configure operational rate limits
and accountable invitation distribution before exposing the service.

This candidate supports invited browser requests and native egress configured
with `admission: {origin, token_file}`. The native helper derives the origin from
the authenticated manifest; Go loads the canonical owner-only token file once
and injects it only for exact session AUTH POSTs. Incoming SDK headers cannot
override it, and redirects cannot carry it elsewhere. Enable `allowNativeRequests`
for the native path. The immutable historical native release lacks this support;
new candidate TLS fixtures do not establish the PD-09 public lifecycle.

For the selected CloudFront deployment,
[nginx.cloudfront.conf.example](nginx.cloudfront.conf.example) supplies the
private origin configuration. Its initial nginx 1.30.5 syntax check was local;
the selected configuration has since been installed behind the CloudFront VPC
origin and checked over actual public HTTPS. See the
[operator bootstrap](../../docs/evidence/PD-aws-operator-bootstrap.md) and
[gateway verification](../../docs/evidence/PD-gateway-node-fetch.md).
Those route checks do not establish a completed funded lifecycle. The alternative
[nginx.same-origin.conf.example](nginx.same-origin.conf.example) is a
TLS reverse-proxy template. It preserves canonical routes and Origin, clears
untrusted forwarded headers and disables retries. The reserved example hostname,
certificate paths and listener must be replaced with reviewed values. The file
has not itself been syntax-tested with nginx or validated over deployed public TLS.
Client aborts cancel bounded upstream reads/forwards; cancellation never rolls
back a saved reservation or assumes an AUTH was not accepted. No inference is
relayed or retried. An independent SDK's read-only preflight is covered through
canonical gateway routes using synthetic local chain/indexer/control fixtures.
Actual cross-origin browser, public HTTPS, provider and native lifecycle
acceptance remain PD-04/08/09 work on the selected deployed service.

The earlier `configuredBrowserChatHost` remains the historical reference-app
host with its own pinned build contract. Its optional `publicOrigin` supports
same-origin TLS for that legacy app, independently of the new `public-api` mode.
No existing host, custody namespace, profile or running service was migrated.

Use HTTPS and the pinned application worker, with IndexedDB, Web Locks, Web
Crypto and module Worker support. The existing CSP allows the same origin and
`https://openrouter.ai` for direct provider requests. Hosting must preserve the
same public origin and custody namespace for funded notes. Do not move users to
a fresh origin, reset storage or silently switch direct requests to proxy.

## Diagnostics and service readiness

`GET /relay-status` is a redacted configuration report. It reports admission and
recovery policy and whether RPC/indexer/control callbacks were configured. It
performs no network request, budget reservation, AUTH, transaction, inference
or custody change. It explicitly reports `readiness: "not_checked"` and leaves
signer, provider credit and finalized Pool checks `not_checked`. HTTP 200 from
this route is not service readiness. It rejects request credentials and returns
no filesystem paths, wallet identifiers, request IDs, endpoint credentials or
raw upstream errors. `/provider-budget` supplies validated capacity totals,
never the individual immutable reservation rows.

Use the SDK public-profile preflight for actual read-only asset/manifest/chain/
indexer/model validation. Provider credit, signer reconciliation and challenger
readiness require independent operator observations. The existing private
[operations collector](../operations/README.md) checks signer, ledger, finalized
chain/indexer, fee payer and challenger; it currently requires numeric loopback
HTTP sources and a local read-only database role. Do not publish its private
config or pretend an unavailable source is a healthy zero. An external public
readiness endpoint aggregating these authenticated live sources remains work.

## Required deployment and funding decisions

Before publishing a supported default, record an operator/owner, the actual
AWS-generated CloudFront HTTPS hostname, availability and retirement windows, the canonical compatible
program/Pool/setup, actual admin and upgrade authorities, and exact source,
release, profile and artifact hashes. The exact inherited setup-file
redistribution review is complete; retain its reviewed notices and validate
anonymous complete downloads before linking onboarding to that profile.
The selected operator needs persistent PostgreSQL, independent signer journal,
provider dispatch claims, indexer archive and challenger state, with tested
backup/restore and shutdown procedures. Never replace one with empty state.

The release accepts Circle Devnet USDC mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, six decimals, under SPL Token
`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. A maintainer must provide verified
current SOL and Circle test-USDC acquisition instructions for the chosen public
service. Check cluster, mint, decimals and recipient before funding. For a
1,000,000-micro-USDC cap, 2 USDC supplies two caps before charges; any nonzero
charge leaves less than two full caps. SOL for transaction fees and account rent
is separate. Mainnet USDC and arbitrary tokens named USDC are not interchangeable.

Devnet funds do not pay real provider charges. The approved seven-cap acceptance
grant supplies the selected preview's bounded provider exposure. Record the
responsible operator, rate/access limits, invitation distribution and a way to
distinguish subsidy/credit exhaustion from low note balance. Ordinary hosted
users must not receive or supply provider management
keys. Advertise only model/API/mode, streaming and tool combinations that have
separate current public lifecycle evidence; older private/custom-relay successes
remain historical evidence. Required live acceptance includes verified signed
settlement, same-journal recovery and withdrawal, plus an emergency path drill.
