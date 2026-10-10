# Set up a proxy or payment API operator

Choose how inference reaches the provider, then follow the corresponding setup:

| Operating mode | Request path | Start here |
|---|---|---|
| Inference proxy (`proxy`) | Client → your control/dispatcher → OpenAI, Anthropic or OpenRouter | Steps below |
| Direct OpenRouter (`direct_openrouter`) | Client → OpenRouter using an issued session key; your operator authorizes and settles | [Complete public operator setup](operators/direct-openrouter.md) |

Both modes use the same Solana USDC ledger, proof verification, signer and
recovery rules. Proxy operators can see prompts and responses. The existing
`public_devnet_gateway.ts` and AWS bootstrap implement direct OpenRouter; they
do **not** forward proxy inference routes. Do not put a proxy deployment behind
that gateway and expect inference to work.

The proxy steps use the implemented local/Devnet launcher and a separately
configured HTTPS ingress. They require reviewed program/Pool, provider and
tariff inputs. **There is no general public-proxy manifest/profile publishing
CLI in this repository.** The supported chain helper can sign a local loopback
provider manifest; a fresh public proxy additionally requires a reviewed
manifest/profile authoring and publication integration. The direct OpenRouter
guide has the existing public staging/bootstrap path. Production isolation,
public proxy acceptance and full provider
coverage remain separate from the [recorded preview status](../status.md).
An existing operator should use [maintenance](operators/same-state-restart.md)
and preserve its original financial state.

## 1. Prepare provider access and a matching Devnet deployment

Complete [API provider setup](api-provider.md) for one supported proxy adapter:
OpenAI Chat/Responses, Anthropic Messages, or OpenRouter Chat. Its preparation
output must contain private `providers.json`, `tariffs.json` and credentials.
For a proxy-only operator, use a prepared selection whose `direct` list is empty
and whose `proxy` list contains the intended providers. Real inference rights,
model limits and all applicable input/output/cache prices must be verified.

If you do not have setup/build/Pool inputs yet, follow
[fresh chain deployment](operators/chain-deployment.md), including its local
proxy branch. Then prepare an independently reviewed initialized deployment with:

| Input | Required content |
|---|---|
| Setup directory | Fresh OS-random `public-profile.json`, its pinned proving artifacts and original private role seeds |
| Deployment directory | `deployment.json`, signed `public-manifest.json`, `build-manifest.json`, `vault-idl.json`, finalized `initialize-receipt.json`, plus the separately located matching `zkapi_vault.so` |
| Manifest | Your exact control/inference origins and hashes of every prepared proxy tariff |
| RPC access | Two independent HTTPS Devnet origins; archive history from the original Pool initialization slot |
| Challenger | Original private fee-payer key and Devnet SOL; matching tree proving key |

[Deployment inputs](deployment-inputs.md) explains SDK trust, model and tariff
bindings. [Chain deployment](operators/chain-deployment.md)
provides the setup, build, deployment and initialization commands. Public staging is specific
to direct OpenRouter; a proxy operator must supply a separately signed manifest
with the proxy tariff hashes and intended origins. The launcher checks these
inputs; it does not create a public proxy profile or deploy/initialize a Pool.
Do not substitute the published direct-mode consumer profile or known-entropy
local test keys.

Run as a non-root account with Rust 1.90.0, Node 24.19.0, npm 11.9.0, Python 3 and
PostgreSQL 16 tools (`initdb`, `pg_ctl`, `psql`) on `PATH`. Use a new private,
persistent state directory with a short path; Unix sockets have length limits.
The launcher owns its isolated PostgreSQL cluster. Do not point it at an
existing hosted database or signer journal.

## 2. Install dependencies and validate the backend configuration

From the pinned repository checkout:

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run typecheck
npm run build:sdk
cargo build --release --locked --manifest-path services/indexer/Cargo.toml --bin indexerd
```

Create an owner-only `/private/proxy-rpc.env` containing
`SOLANA_DEVNET_RPC` and `SOLANA_DEVNET_SECONDARY_RPC` with the two private HTTPS
RPCs. It must not be a public asset. Set the actual paths below in a Bash shell;
all paths refer to inputs prepared in step 1:

```sh
umask 077
export ZKAPI_NODE="$(command -v node)"
ZKAPI_DEPLOYMENT='/private/proxy-deployment'
ZKAPI_PROGRAM='/private/program-build/zkapi_vault.so'
ZKAPI_SETUP='/private/proxy-setup'
ZKAPI_SETUP_SHA256='INDEPENDENTLY_RETAINED_SETUP_PROFILE_SHA256'
ZKAPI_PROVIDERS='/private/provider-state'
ZKAPI_BACKEND='/private/proxy-backend'

zkapi_backend_args=(
  --deployment "$ZKAPI_DEPLOYMENT"
  --program "$ZKAPI_PROGRAM"
  --output "$ZKAPI_BACKEND"
  --env-file /private/proxy-rpc.env
  --provider-state "$ZKAPI_PROVIDERS"
  --public-devnet-profile "$ZKAPI_SETUP"
  --public-devnet-profile-sha256 "$ZKAPI_SETUP_SHA256"
  --indexer http://127.0.0.1:18883
  --port 18887 --pg-port 55446
)
python3 scripts/run_i10_devnet_backend.py prepare "${zkapi_backend_args[@]}"
```

`prepare` builds debug `controld`, `signerd` and `dispatcherd`, validates setup,
manifest and tariff pins, writes immutable identity/configuration, and initializes
the new signer journal once. It calls no RPC or provider. Expect `status:
"prepared"` and `configuration_validated: true` in the private
`runtime-report.json`; `provider_dispatcher` records configuration validation.
A changed configuration beside existing identity is a recovery error, not a
reason to delete files.

The generated dispatcher has a dedicated SELECT-only PostgreSQL login and
private one-shot claims. Control receives no usable provider credential path.
The launcher uses a shared local OS identity and a local test database owner
for control/signer, so this is not production credential or database isolation.
Use the [operations manual](operators/operations.md#provider-isolation) and
[local-fixture database-role reference](../../services/control/README.md#database-roles-and-first-start)
for the isolation requirements and runtime permission contract when deploying
independently managed daemons.

## 3. Initialize the private database and verify the signer

```sh
python3 scripts/run_i10_devnet_backend.py check-local "${zkapi_backend_args[@]}" --no-build
```

This starts the new private PostgreSQL cluster, migrates/provisions its schema,
checks durability and signer reconciliation, then shuts its processes down.
It does not issue a provider key, send inference or submit a chain transaction.
Require `signer_reconciled: true`, `postgres_durable: true` and a successful
command exit. Preserve `cluster.json`, `identity.json`, PostgreSQL data, signer
journal and dispatcher claims for every subsequent start.

## 4. Start the indexer, backend and challenger

Create `/private/proxy-indexer.json` with the exact schema below, substituting
the authenticated manifest pins, original finalized initialization slot and
private RPC. The snapshot directory belongs to the same non-root operator:

```json
{
  "rpc_url": "https://YOUR_ARCHIVE_DEVNET_RPC",
  "program_id": "PROGRAM_FROM_MANIFEST",
  "pool": "POOL_FROM_MANIFEST",
  "genesis_hash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "circuit_profile_hash": "CIRCUIT_PROFILE_HASH_FROM_MANIFEST",
  "start_slot": 1,
  "listen": "127.0.0.1:18883",
  "public_origin": "https://YOUR_INDEXER_ORIGIN",
  "snapshots_directory": "/private/proxy-snapshots"
}
```

`start_slot: 1` is a placeholder; use the recorded initialization slot or a
reviewed earlier replay slot. Keep this terminal running:

```sh
services/indexer/target/release/indexerd /private/proxy-indexer.json
```

In the Bash shell from step 2, wait for a fresh finalized root for the intended
Pool, then start the backend:

```sh
curl --fail --silent --show-error http://127.0.0.1:18883/zkapi/v1/tree/root
python3 scripts/run_i10_devnet_backend.py serve "${zkapi_backend_args[@]}" --no-build
```

`serve` validates RPC genesis, starts PostgreSQL/signer/control and stays in
the foreground. Require `status: "serving"`, `database_accepting: true` and
`signer_reconciled: true` in its private report. A reachable config endpoint
without accepting/reconciled state is not inference readiness.

While the backend remains running, prepare the challenger in another terminal:

```sh
python3 scripts/run_i10_devnet_challenger.py prepare \
  --deployment /private/proxy-deployment \
  --backend /private/proxy-backend --output /private/proxy-challenger \
  --fee-key-file /private/challenger-fee-key.json \
  --payer YOUR_CHALLENGER_PUBLIC_KEY \
  --node "$(command -v node)" --tree-pk /private/proxy-setup/tree.pk --release
services/challenger/target/release/challengerd run /private/proxy-challenger/config.json
```

Preparation creates its separate read-only role and validates/initializes a new
journal without provider calls or chain sends. `challengerd run` is an active
financial protection service: it can sign and submit required challenges using
its fee payer. Check matching Pool, fresh ready health and chain catch-up before
accepting funded users. The bounded test wrapper's `serve` is not a permanent
service supervisor; supervise the underlying daemon with these same inputs.

## 5. Configure the proxy's HTTPS ingress

Terminate HTTPS at the exact origins already signed into the manifest. Route
control `/zkapi/v1/*` to `127.0.0.1:18887`, tree routes to `127.0.0.1:18883`, and
the supported inference routes to the same control listener:

| Provider | Inference route |
|---|---|
| OpenAI | `POST /v1/chat/completions`, `POST /v1/responses` |
| OpenRouter | `POST /v1/chat/completions` |
| Anthropic | `POST /v1/messages`, optional `POST /v1/messages/count_tokens` |

For example, inside the nginx TLS server for the exact manifest inference
hostname, these locations stream requests to the existing control service:

```nginx
location ~ ^/v1/(chat/completions|responses|messages|messages/count_tokens)$ {
    limit_except POST { deny all; }
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:18887;
    proxy_set_header Host YOUR_EXACT_MANIFEST_INFERENCE_HOST;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Idempotency-Key $http_idempotency_key;
    proxy_set_header X-API-Key $http_x_api_key;
    proxy_set_header Anthropic-Version $http_anthropic_version;
    proxy_set_header Cookie "";
    proxy_next_upstream off;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 610s;
}
```

This is a server-block fragment, not a complete ingress configuration. Replace
the fixed Host with the manifest authority, including its port if present;
never derive it from an untrusted forwarded header. Keep request/response bodies
and credentials out of logs. Configure certificate trust, bounded control/tree
routes, browser CORS or an application relay, rate limits and forwarding-header
policy, then run `nginx -t`. Do not add redirects or retries. Browser Origin must
match the manifest control or inference origin; cross-origin apps need a reviewed
same-origin relay. Literal loopback deployments use an explicitly trusted local
TLS setup rather than the public profile loader.

Verify catalog and ready indexer through the intended client transport. An
unauthenticated inference request must be refused without provider egress.
Keep PostgreSQL, signer and administration inaccessible from public ingress.

## 6. Connect an SDK or clientd client in proxy mode

Use [SDK setup](sdk.md) with your reviewed [deployment inputs](deployment-inputs.md),
`mode: "proxy"` and the same model/API/tariff objects. Do not configure direct
provider bases or give an end user an operator provider key. The SDK authorizes
through your control service and sends inference to the manifest inference
origin with its session credential and one operation identity.

For distribution, create and authenticate your own complete
[public profile](../sdk/public-profile.md) with `mode: "proxy"`, exact bundle
URL/hash, browser-safe RPC, indexer origin, reviewed models and capabilities.
All URLs must satisfy the public profile contract, which rejects literal
loopback/private hosts. For clientd, follow [installation](clientd.md) using
this profile URL/hash instead of the public direct-mode preview profile.
There is no automatic direct-to-proxy fallback.

Verify fresh read-only preflight, expected catalog, provider account capacity
and challenger readiness before depositing. A funded acceptance then follows
the SDK/clientd guide: correct Devnet funding, one explicitly bounded request,
complete stream consumption, signed `PROXY_USAGE` settlement, same-journal
recovery and finalized withdrawal. Use a newly reviewed provider budget;
previously consumed acceptance cases cannot be replayed. A waived or unknown
receipt is not successful inference acceptance.

## 7. Keep the operator usable

Stop admission before maintenance, retain the exact ledger/journals and drain
accepted work. The [operations manual](operators/operations.md) covers private
monitoring, provider fencing and restore validation;
[archive storage](operators/archive-storage.md) covers disk headroom. Use
[incident handling](operators/incidents.md) for user-facing status updates.

| Failure | Check before continuing |
|---|---|
| Tariff absent or provider configuration rejected | Prepared tariff hashes, manifest signature, model/API limits and credential type |
| Existing identity or signer journal mismatch | Original Pool, setup, database and journal; do not recreate state |
| Empty catalog or admission disabled | Database, signer reconciliation, finalized indexer and Pool state |
| AUTH succeeds but inference is refused | Exact inference Host, supported route, session mode, model and operation identity |
| Browser fails while native requests work | HTTPS trust, Origin/CORS and application relay; do not disable TLS verification |
| Inference or transaction result is unknown | Original saved operation and [recovery procedure](recovery.md); never resend automatically |
