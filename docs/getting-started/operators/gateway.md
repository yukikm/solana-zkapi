# Public Devnet gateway configuration

Start with [operator setup](../proxy-operator.md) for the ordered installation
procedure. This manual describes the public direct OpenRouter gateway. To
install a client, use [clientd](../clientd.md) or [SDK setup](../sdk.md).

| Task | Guide |
|---|---|
| Configure a new operator and publish its profile | [Deployment](deployment.md) |
| Understand AWS networking, storage and cost | [Hosting](hosting.md) |
| Configure provider spending and preserve old grants | [Budget policies](budget.md) |
| Install server service units | [systemd](service-units.md) |
| Handle an outage | [Public Devnet incidents](incidents.md) |
| Back up or restart existing services | [Same-state maintenance](same-state-restart.md) |
| Manage archive growth and disk exhaustion | [Archive storage](archive-storage.md) |
| Monitor services and verify restoration | [Operations](operations.md) |

The current preview uses operator-funded usage without a fixed trial allowance
and does not require invitations. Historical grants and reservations remain
unchanged. See [support and verification status](../../status.md) for dated
observations and remaining browser, provider and long-term operating limits.

## Gateway configuration

`scripts/public_devnet_gateway.ts` reads authenticated public profile and bundle
files from the operator installation. The existing SDK loader validates exact
profile, descriptor, artifact and WASM hashes, manifest trust and model bindings.
It validates the selected budget policy and listens only on `127.0.0.1`.

Run from the pinned checkout with an owner-only configuration:

```sh
node scripts/public_devnet_gateway.ts --config /srv/zka/config/gateway.json
```

| Field | Purpose |
|---|---|
| `port`, `publicOrigin` | Loopback port and exact public HTTPS origin |
| `allowedBrowserOrigins` | Exact HTTPS origins, or `["*"]` for any browser origin without cookies |
| `allowNativeRequests` | Permit clients without Origin and with absent Fetch Metadata or only Node fetch's `Sec-Fetch-Mode: cors` |
| `allowTransactions`, `allowNewAdmissions` | Global write policy and separate new-admission policy |
| `requireInvitation` | Defaults to `true`; explicitly set `false` for public admission |
| `admissionTokenSha256` | Private invitation digest; required for invitation-gated new admission |
| `profileUrl`, `profilePath`, `profileSha256` | Canonical public URL, installed profile and independently authenticated exact digest |
| `bundleDescriptorPath` | Installed bundle descriptor with its flat public assets beside it |
| optional `modelProfile` | Separately pinned model expansion `{url, path, sha256}`; original profile and financial bindings remain unchanged |
| `rpcUrl`, optional `historyRpcUrl` | Private HTTPS upstream RPCs |
| `indexerUrl`, `controlUrl` | Fixed upstream service origins: HTTPS or numeric-loopback HTTP |
| optional `localCaPath` | Existing local service CA; never disables verification or changes public TLS trust |
| `budget` | Explicit [operator-funded or existing finite policy](budget.md) |

`publicOrigin` must equal the manifest's control origin and profile's indexer
origin; the profile RPC must be exactly `publicOrigin + "/rpc"`. The base profile
binds one OpenRouter Chat model, direct provider base
`https://openrouter.ai/api/v1` and a 1,000,000-micro-USDC cap. A separate
`modelProfile` can expand discovery after validation against that base. This
does not turn the gateway into a proxy-inference or differently capped service.

The gateway routes canonical `/zkapi/v1/*` configuration, catalog, attestation,
tariff, quote, session, receipt, withdrawal and indexer operations plus `/rpc`,
`/relay-status` and `/provider-budget`. It retains method, credential, exact
AUTH, signed transaction, program, Pool, fee and budget validation. It refuses
arbitrary upstream destinations, selected-note queries, old `/control` and
`/indexer` prefixes, provider inference and application files.

Publish immutable profiles and complete bundles through a separate static
origin with public credential-free CORS. Applications serve their own workers
and static files. Private configuration, seeds, RPC credentials and journals
must never enter a web root. The exact upstream notices in
[upstream-notices](../../../deploy/public-devnet/upstream-notices/PROVENANCE.md) are authenticated bundle
inputs and must retain their original bytes.

## Browser and native access

For the optional local operator relay used by existing standalone browser
builds, follow [Browser relay startup](browser-relay.md). New application
developers start with [SDK setup](../sdk.md).

`allowedBrowserOrigins: ["*"]` permits HTTPS applications, HTTP localhost and
opaque (`null`) origins. Do not combine `"*"` with other entries. An exact HTTPS
list restricts browser origins. Use `credentials: "omit"`; wildcard CORS is
incompatible with cookies and `credentials: "include"`.

Preflight permits the reviewed method, `Authorization` and `Content-Type`.
`x-zkapi-admission` is permitted only for exact session AUTH. Same-origin
requests without Origin require wildcard mode or the gateway origin in the
allowlist, plus matching Fetch Metadata. Native requests require
`allowNativeRequests: true`; any other Fetch Metadata header excludes the
native branch. Cookie, API-key, proxy-authorization and forwarded-origin
overrides are refused. Origin checks do not authenticate arbitrary native
clients; protocol credentials and budget validation still apply.

If invitations are enabled, generate 32 random bytes encoded as unpadded
base64url (43 characters). Configure the lowercase SHA-256 of the UTF-8 token
text, not of its decoded bytes. Share the token privately; omit it and its
digest from public files, URLs, logs and browser persistence. The gateway
checks it in constant time and strips it upstream. It is a shared access gate,
not per-user accounting. An invalid invitation cannot reserve a new AUTH.

Native clients use `admission: {origin, token_file}`. The helper derives the
origin from the authenticated manifest; Go reads the canonical owner-only token
file once and injects it only on exact AUTH POSTs. Incoming SDK headers and
redirects cannot forward it elsewhere.

Use [the private CloudFront nginx configuration](../../../deploy/public-devnet/nginx.cloudfront.conf.example)
with the actual generated hostname. The alternative
[same-origin TLS template](../../../deploy/public-devnet/nginx.same-origin.conf.example) requires reviewed
hostname, certificates and listeners, plus target-host validation. Both preserve
canonical routes and Origin and disable upstream retries. Client cancellation
never rolls back an existing reservation or proves an AUTH was not accepted.

Browser custody requires HTTPS, the pinned module worker, IndexedDB, Web Locks
and Web Crypto. Preserve the same application origin and custody namespace for
funded notes. A deployment update must not reset storage or switch direct
requests to proxy.

## Suspend new admission while retaining recovery

Set `allowTransactions: true` and `allowNewAdmissions: false` while preserving
the existing deployment, ledger and journals. `allowTransactions: false` blocks
all recovery writes as well and is a separate global write stop.

| Operation with new admission suspended | Behavior |
|---|---|
| New direct AUTH or deposit creation | Refused before forwarding |
| Exact existing direct AUTH | Recovery is subject to the selected budget policy and original signed transcript |
| Changed bytes for an existing AUTH | Refused |
| Existing upload append/seal/execute/close | Retains signature, program, Pool and fee guards |
| Session status, receipts, close and withdrawal clearance | Retains authentication and validation |
| Escape creation and finalization | Retains signed transaction checks |
| Proxy inference and legacy proxy AUTH | Refused |

Finite authorities require the original reservation and re-fsync it before
forwarding. Operator-funded mode requires an authenticated existing-session
read; the control ledger checks its original transcript and does not reissue a
key. An unavailable or missing session cannot authorize a new AUTH.

Admission suspension cannot revoke issued provider keys. Existing sessions
still need their normal stop, usage collection and signed settlement lifecycle.
AUTH recovery never authorizes inference replay, and policy alone does not
establish that all recovery dependencies are available.

## Readiness and diagnostics

| Endpoint or check | Meaning |
|---|---|
| `/relay-status` | Redacted configuration; `readiness: "not_checked"`, no network probe or reservation |
| `/provider-budget` | Selected spending policy and aggregate allowance, if finite; not provider credit |
| `/zkapi/v1/readiness` | Bounded control, indexer and signer observations plus pinned provider capability |
| SDK public-profile preflight | Actual asset, manifest, finalized-chain, indexer and model checks |
| Private operations collector | Ledger, signer, finalized-chain, fee-payer and challenger checks |

Public readiness does not check provider credit, admission policy or challenger
health. A Clock/account-context mismatch permits one additional finalized read
within the 25-second probe deadline. Known transient RPC reads allow one retry
after 250 ms; rate limits, malformed replies and identity failures do not.
The complete final cut must validate; no financial request is retried. See the
[control service](../../../services/control/README.md) and
[private collector](operations.md) for details.

Record an operator, availability and retirement policy, immutable deployment
and release pins, verified funding instructions, backup/restore checks and a
contact path before advertising a deployment. Devnet tokens do not pay real
provider charges. Follow [funding and access](../devnet-funding.md)
for the exact cluster, mint, cap and fee prerequisites.
