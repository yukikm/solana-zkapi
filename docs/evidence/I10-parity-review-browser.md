# Configured local devnet browser demonstration

Date: 2026-10-07 JST. The standalone application now has a concrete local build
connected to the fresh public devnet deployment. Its service wiring and local
regressions passed. Actual use through the user's Chrome/Phantom remains blocked
by Chrome's `ERR_BLOCKED_BY_CLIENT` at `http://127.0.0.1:4174`.

This is a separate scope from the successful native OpenRouter JSON/SSE cases in
[the live aggregate](I10-parity-review-live-components/results.json). No browser
deposit, AUTH, inference or new budget reservation occurred in this follow-up.

## Corrected integration gap

Previously the default standalone build had no reviewed deployment, and the old
wallet host only supported a fixed OpenAI proxy request. Adding a dropdown entry
would not have provided artifact distribution, logical service routing or safe
direct-mode budget admission. The following now compose the existing SDK state
machines; no parallel financial journal was introduced:

- [Offline packager](../../scripts/prepare_browser_chat_devnet.ts): validates the
  independently retained OS-random profile digest, signed manifest, state and
  clearance roles, quote/receipt roles, exact public artifacts and WASM. After
  verification it freezes the exact manifest hash into the public profile.
  An exclusive private output directory contains a separate RPC host config.
- [Configured browser build](../../examples/browser-chat/build.mjs): accepts an
  explicit public profile plus its independently retained SHA256, validates its
  closed schema and writes an isolated bundle with hashes of all five assets.
  The default unconfigured source build stays separate.
- [Local host](../../scripts/browser_chat_devnet_host.ts): verifies the installed
  profile and asset hashes before serving their exact bytes. It reuses the
  existing bounded devnet financial relay and provides only reviewed control
  routes. Private RPC and backend configuration never become browser assets.
- [App transport](../../examples/browser-chat/load-deployment.ts): maps logical
  RPC/indexer/control origins to the same localhost origin. Manifest bindings
  remain unchanged. Provider inference goes directly to the exact OpenRouter
  endpoint; there is no direct-to-proxy fallback.
- [Shared budget extension](I10-parity-review-demo-budget.md): reserves the full
  one-USDC key cap against the request UUID and exact AUTH hash before forwarding
  a new AUTH. Exact recovery does not create a second reservation or permit
  inference replay. Old rows, proxy-demo behavior and funded withdrawal remain
  supported. The frozen native acceptance coordinator deliberately rejects the
  new row kind until a separately reviewed compatibility update.
- Public admission hints show remaining capacity and distinguish worst-case
  reservations from actual charges. The UI rechecks before a new deposit or
  request. Unavailable/exhausted capacity leaves recovery and withdrawal usable;
  the host's durable reservation remains authoritative.

The host cannot observe direct provider packets or independently enforce their
model/operation count. Its monetary bound is the complete issued-key cap, while
the existing SDK admits one inference operation per session. See the
[host review](I10-parity-review-browser-host.md) and
[application provisioning review](I10-parity-review-browser-provisioning.md).

## Installed local instance

| Item | Value |
|---|---|
| App origin | `http://127.0.0.1:4174` |
| Program | `8iwjnYVNuRQhyijbcYGWGctyty7d8FEt8JnT8dWmCjSd` |
| Separate unfunded browser Pool | `2aeTCsHthoockF8LC8N3UfP312BZ8uJ6sfuMbA2rot1w` |
| Public browser-profile SHA256 | `270ff0fea81bed8b809b3d4335af7392a95dc122a12414ed0f058abd6af2eaf4` |
| WASM SHA256 | `c06a247e1ff88f1ac415ea127bcf49d486b5b4954715cdf00f133b5ac71c1f30` |
| Public profile file | `target/parity-chat-demo-pinned/reviewed-profile.json` |
| Private host config | `target/parity-chat-demo-pinned/private-host-config.json` |
| Browser bundle | `target/parity-chat-browser` |
| Persistent backend | `target/pd-chat` |
| Indexer/backend local ports | `19683` / `19687` |

The exact public profile is saved in the
[evidence copy](I10-parity-review-browser-components/reviewed-profile.json).
The earlier Ed25519-anchored packaging checkpoint is retained; the final build
additionally freezes the exact verified manifest hash. No funded browser state
was migrated between them. The native direct JSON/SSE notes are already closed;
this browser Pool and its running services are separate.

The final build and host commands, from the repository root, are:

```sh
target/i08-toolchain/bin/node examples/browser-chat/build.mjs \
  --profile target/parity-chat-demo-pinned/reviewed-profile.json \
  --profile-sha256 270ff0fea81bed8b809b3d4335af7392a95dc122a12414ed0f058abd6af2eaf4 \
  --out-dir target/parity-chat-browser

target/i08-toolchain/bin/node scripts/browser_chat_devnet_host.ts \
  --config target/parity-chat-demo-pinned/private-host-config.json
```

They use the already prepared local backend and indexer. Do not start duplicate
listeners, replace their state or reinitialize the parent budget. If those
services have been stopped, restart the same state in separate terminals:

```sh
services/indexer/target/release/indexerd \
  target/public-devnet/parity-review-20261007/deployment/pools/provider/parity-chat/private-indexer.json

python3 scripts/run_i10_devnet_backend.py serve \
  --output target/pd-chat \
  --deployment target/public-devnet/parity-review-20261007/deployment/pools/provider/parity-chat \
  --program target/public-devnet/parity-review-20261007/deployment/zkapi_vault.so \
  --env-file .env --indexer http://127.0.0.1:19683 --port 19687 --pg-port 55452 \
  --provider-state target/i10-provider-acceptance/configurations/parity-chat \
  --public-devnet-profile target/public-devnet/parity-review-20261007 \
  --public-devnet-profile-sha256 3933fcae97f544f0be368532cc9c2127af8f7fc008cbebcf2ddd0f803abfd311 \
  --no-build
```

The indexer may need its existing bounded archive replay before common snapshots
are ready. This is not a startup-latency or availability SLO. Keep the same browser
origin, account and storage namespace for any later custody. The backend, indexer
and host were left running for the pending browser follow-up, as recorded in
[service status](I10-parity-review-browser-components/live-services-status.json).

## Verification and remaining blocker

The [configured read-only check](I10-parity-review-browser-components/configured-readonly-results.json)
passed 17 HTTP checks: exact bundle hashes, manifest/WASM, budget totals, actual
devnet RPC genesis, shared snapshot digest and control configuration. Private
config, `.env`, legacy demo and inference-proxy routes were refused. No wallet,
quote, AUTH, provider call or budget mutation was involved. Current capacity is
seven additional full-cap sessions within the existing monetary/request limits;
the ten earlier reservations remain unchanged at 2,154,216 micro-USDC.

The [final local matrix](I10-parity-review-browser-components/final-local-results.json)
passed 73 wallet UI tests and strict packager/host typechecking. The linked final
SDK aggregate passed 304 tests with zero skips, all six stages, and 517 unchanged
source inputs in 19.389 seconds. Separate overlapping reports record 26 host
tests, 22 browser helper/conversation tests plus one actual isolated Chrome
scenario, eight new and 22 legacy Python budget tests, and 75 recovery tests.
The [five packaging checks](I10-parity-review-browser-components/packaging-results.json)
used actual pinned artifacts with synthetic private RPC canaries and verified
wrong-pin rejection, output preservation and private/public separation. Counts
must not be summed as unique tests. Synthetic Chrome and proof fixtures do not
establish real Phantom or provider acceptance.

Actual navigation in the existing user Chrome profile produced
[ERR_BLOCKED_BY_CLIENT](I10-parity-review-browser-components/chrome-current-block.json),
confirmed by the native accessibility tree. Browser protection was not changed
or bypassed. The user was asked to make the localhost page accessible. The final
bundle uses the same origin; no later successful browser observation is claimed.

After that block is resolved, the remaining live sequence is compact Phantom
funding, plain and streaming conversation on the same note, explicit cancellation
and reload recovery, signed settlement, and withdrawal. Other models/APIs,
direct OA, public hosting, complete I10/G3 and production release gates remain
separate. Mainnet deployment and an independent audit are later milestones, not
defects against this devnet review target.
