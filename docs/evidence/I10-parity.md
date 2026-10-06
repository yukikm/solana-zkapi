# Ethereum parity follow-up

Date: 2026-10-06 UTC. Working baseline:
`a9c3364a89990e22b0a3c3d0bddee82493017987`. Ethereum reference:
`045b444ea1b52538d1b40273c7cb6ed09468a052`.

This implementation targets a reviewable Solana devnet demonstration. Mainnet
deployment and a third-party audit are later milestones, not failures of this
local implementation gate. Local execution is not public deployment evidence.

## Changes and evidence

| Area | Change | Evidence |
|---|---|---|
| Authorization privacy | Common snapshot/shared-account reads and local original-Poseidon reconstruction replace selected-note AUTH lookups | [Privacy](I10-parity-privacy.md) |
| Public devnet trust | OS-random tree setup and separate private signing roles, independently pinned build/backend/signer/challenger configuration; explicit legacy opt-in | [Deployment](I10-parity-deployment.md), [integration](I10-parity-public-profile.md) |
| Native model UX | Per-model provider/API/tariff configuration; a verified close allows the same new send to proceed after a model switch | [Clientd](I10-parity-clientd.md) |
| Browser UX | Standalone arbitrary text/history/model/API/SSE/cancel interface, expiry and explicit financial recovery; fixed funded demo retained separately | [Browser](I10-parity-browser.md) |
| Browser custody | Explicit initial persistence request, honest retention status, reliable browser-test teardown | [Storage](I10-parity-storage.md) |
| Operator outage and interrupted recovery | Signed unaccepted-AUTH clearance, same-journal emergency escape, challenge reconciliation and safe expired-create reproof | [Recovery](I10-parity-emergency-escape.md), [real SBF](I10-parity-pending-escape-sbf.md) |
| Dependency compatibility | web3.js 1.99.0, Anchor 0.31.2, Solana-program 2.3.0, LiteSVM 0.7.1 and coordinated lockfiles | [Dependencies](I10-parity-dependencies.md) |

The dependency changes use current compatible releases and are tested together.
They do not claim migration to the latest incompatible Anchor, Kit, Solana or
SBF-toolchain major. The compiler-backed IDL remains byte-identical.

## Verification checkpoints

- Final SDK regression: **291 passed, zero skips**, including actual Chrome
  custody. SDK/example/runtime/UI typechecks and the final browser application
  build/Chrome scenario passed. All 417 guarded runtime/build/test inputs were
  unchanged during the final run; [results and log hashes](I10-parity-final-results.json).
- Original-circuit/upstream sparse path checks: three passed. Actual fresh native
  and WASM path reconstruction: one passed, with tampering rejected.
- Privacy transport plus relay guard checks: 24 passed, zero skips.
- Actual SBF compact deposit: 61 passed; legacy Vault matrix: 366 transactions
  (203 accepted and 163 expected rejections), including proof, withdrawal and
  challenge paths. These are the harness's local coverage, not all I04/I10 gates.
- Fresh public-profile SBF: eight signed cases, including genuine new tree proofs,
  compact deposit/expiry Token CPI and rejection of fixture keys/setup.
- Two independently generated setups with proof verification; 19 artifact/seed
  guards and 10 host-build cases passed. Role secrets stay in ignored private
  directories and are not evidence artifacts.
- The final emergency escape integration uses genuine native request/withdrawal/
  tree proofs and actual SBF: ten signed transactions, maximum 338,201 CU and
  1,232 bytes, one AUTH, one synthetic inference and zero inference replays.
  Response loss and restart preserve the exact journal; the destination receives
  5,000,000 micro-USDC, Vault and treasury end at zero. [Final report](I10-parity-final-sbf-results.json).
  The earlier SBF report remains a separate source snapshot.
- Upstream pins, design/schema/link validation and `git diff --check` passed.
  The older saved-deployment challenger integration could not run without its
  ignored deployment artifacts and local PostgreSQL tools; its prerequisite
  failure is retained in the final report. Focused new profile/configuration
  checks are separate from that unexecuted service integration.

Detailed component records preserve failed intermediate runs and distinguish
synthetic browser/provider traffic from actual native/WASM/SBF execution.

## Independent review

A fresh read-only reviewer found no actionable bypass in the corrected AUTH
network selectors, snapshot authentication, fresh-profile pins, signer or
challenger trust propagation. A separate app reviewer reproduced two recovery
gaps: the missing unaccepted-AUTH clearance action and inability to escape from
an unresolved accepted session during operator outage. Both are corrected.
A fresh financial-recovery reviewer also identified finalization/challenge UI
eligibility, unlanded escape-create expiry recovery, native management routing
and closed-state display gaps. Those corrections passed an independent 80-test
run, typecheck and restart/outage/closed-status reproduction. No unresolved
actionable finding remained in those review scopes. These are scoped engineering
reviews, not a third-party audit or a proof that the implementation is bug-free.

## Public demonstration boundary

The generated fresh profile has not been deployed publicly. The current
standalone app intentionally has no invented endpoint or self-authenticating
trust policy; an operator installs the independently reviewed bundle. Existing
funded deployment pins, historical receipts, journals and provider budget
reservations are preserved. This environment did not contain the existing
credential/wallet/budget files needed to run a new funded provider campaign.

Before advertising broad live parity, demonstrate the fresh deployment with
actual Chrome/Phantom, compact deposit, repeated sends on the same note, model
changes, all configured native APIs and streaming, direct and proxy routes,
settlement, reload/recovery, withdrawal, and operator-down challengeable escape.
Keep one existing authorized provider budget and record actual requests and
finalized transactions; local fixtures do not satisfy that matrix.

Remaining trust differences are explicit: USDC issuer controls, Solana upgrade
authority and the extra tree circuit/setup. Both designs still depend on trusted
application distribution, operator/provider behavior, setup assumptions and
observable network metadata. The new setup is single-party, without an
independent ceremony or attested erasure. Snapshot limits (4 MiB/16,384 records)
fail closed. Browser persistence is not portable backup. These limits should be
disclosed with the devnet demonstration; mainnet or an audit does not itself
remove them.
