# Explicit supplemental acceptance budget

`scripts/provider_supplemental_budget.py` implements one versioned, seven-cap
supplement to an existing campaign. The user explicitly approved seven
additional USDC of maximum provider exposure for B-01–B-03 and N-01–N-04,
without automatic replacement requests. **Approval is received; no actual grant
is initialized and no supplemental reservation or spend has occurred.**
Actual public deployment pins and the single-authority review must be settled
before producing the final authorization record. The
[acceptance plan](../../docs/public-devnet-acceptance-plan.md) records the scope.
Hosting expenditure remains a separate approval.

For the selected fresh AWS authority, use
[the detached V2 workflow](detached-budget.md). It transfers no old remainder and
does not migrate the original ledger. This document retains the V1 local-lock
option. The same seven-USDC approval may initialize **one** of these authorities,
never both or two copies.

The supplement has exactly seven reservations of 1,000,000 micro-USDC each,
60-second direct OpenRouter Chat sessions and a recorded 128-output-token
acceptance limit. Its grant pins the selected profile, canonical manifest
digest, bundle descriptor, tariff, model and SDK/native release digests. The
gateway requires the selected profile to declare streaming and tools for this
seven-case matrix. Three- or six-cap variants and additional grants are not
implemented by this version; they require a separately reviewed version and
explicit approval. No reservation is reclaimed after failure, cancellation,
unknown dispatch, small actual charge or successful withdrawal.

## Authority and migration boundary

The helper locks the **existing** parent `budget.lock`; its constructor creates
neither a campaign nor a lock. The grant anchors exact original plan/identity/
state SHA-256 values and canonical campaign path plus directory/lock device and
inode. Every operation rechecks those anchors. Original identity/state bytes
are never rewritten. The supplemental ledger recognizes exact previously
reserved direct AUTHs and rejects UUID or AUTH-hash collisions across the
original and supplemental rows. Other historical row kinds stay consumed and
are validated; a proxy row lacking an exact AUTH hash cannot authorize a direct
AUTH retry.

This is a local filesystem authority check, **not distributed fencing, remote
clone detection or a backup-restore guarantee**. A filesystem restore may change
device/inode identity and intentionally fails closed. Copying the campaign to
AWS is not an automatic migration. Review and fence authority explicitly before
preparing a grant there; do not move, reset, stop or replace the existing local
services, budget or signer journals merely to satisfy a path check. Existing
legacy helpers remain unchanged. The same flock serializes local operations;
the hash freeze detects subsequent original-ledger changes and stops the
supplement. It does not turn old helpers into supplement-aware writers or make
independent machines share a lock.

## Prepare and validate without initialization

On the already selected, reviewed authority, prepare a public deployment-pin
JSON with these exact fields:

```json
{
  "profile_sha256": "<exact profile bytes SHA-256>",
  "manifest_sha256": "<authenticated canonical manifest_hash>",
  "bundle_sha256": "<exact bundle.json SHA-256>",
  "sdk_sha256": "<reviewed SDK archive SHA-256>",
  "native_sha256": "<reviewed native archive SHA-256>",
  "tariff_sha256": "<authenticated tariff_hash>",
  "mode": "direct_openrouter",
  "provider": "openrouter",
  "model": "<reviewed concrete model>",
  "cap_micro_usdc": "1000000",
  "session_ttl_seconds": 60,
  "max_output_tokens": 128
}
```

Use real 64-character lowercase digests; the placeholders above are deliberately
invalid. This command only reads the original campaign under its existing lock
and prints a proposal with `approval.approved: false`:

```sh
umask 077
python3 scripts/provider_supplemental_budget.py prepare-proposal \
  --plan /reviewed/original-plan.json --state-dir /canonical/campaign \
  --deployment /reviewed/deployment-pins.json > /reviewed/unapproved-grant.json
```

Keep the proposal private: it contains the local authority path/inodes and
original campaign anchors. The authorization file is owner-only, regular,
nonsymlink and at most 1 MiB. After explicit approval of this exact scope, the
operator records `approval.approved: true`, the actual approval reference/date,
and independently installs the SHA-256 of those exact final bytes. A boolean
in a local JSON file is not cryptographic evidence of human approval.

```sh
python3 scripts/provider_supplemental_budget.py validate-authorization \
  --plan /reviewed/original-plan.json --state-dir /canonical/campaign \
  --authorization /reviewed/approved-grant.json --authorization-sha256 APPROVED_SHA256
```

Validation creates no grant files and grants no AUTH permission. It checks the
authorization schema, exact approved scope and current original authority.

## One-time initialization and gateway selection

Only after approval and validation, the operator may run the explicit
`initialize-approved` command with the same arguments. Gateway startup never
invokes it. Initialization durably writes `supplemental-identity.json`, then
`extensions/<authorization-sha256>/authorization.json`, `reservations.json`, and
the immutable single-grant `extensions/index.json`. Any existing marker or
extension directory refuses initialization, including an exact duplicate or
an interrupted partial attempt. Reconcile a partial operation explicitly; do
not remove the marker or create a replacement namespace to recover capacity.

The public gateway accepts the following versioned budget selection:

```json
{
  "kind": "supplemental-v1",
  "planPath": "/reviewed/original-plan.json",
  "stateDir": "/canonical/campaign",
  "authorizationPath": "/reviewed/approved-grant.json",
  "authorizationSha256": "<independently pinned grant SHA-256>",
  "sdkSha256": "<reviewed SDK archive SHA-256>",
  "nativeSha256": "<reviewed native archive SHA-256>"
}
```

The previous `{planPath,stateDir,caseId}` selection continues to use the original
helper. The new adapter compares grant deployment pins to the authenticated
loaded profile, manifest, bundle and tariff before accessing reservations.
The existing relay verifies signed quote/AUTH fields and hashes the exact
request body before asking the helper to reserve. The actual client archive,
output bound, private inference/tool use and case classification remain matters
for independently verified acceptance evidence: an AUTH does not attest the
caller's binary or reveal its direct-provider request body.

New reservation acknowledgement follows file and directory fsync. A failed or
uncertain persistence operation authorizes no forward; its capacity may already
be consumed. An exact retry re-fsyncs existing state/identity files and ancestors
before returning permission. That is AUTH recovery only, never inference replay.
Unknown, substituted, missing or additional grants fail closed. Suspended or
invalid-invitation admissions can recover only an exact existing AUTH and cannot
reserve a new slot.

`status` reports aggregate money/count values without reservation UUIDs, AUTH
hashes, approval details, private paths or journals. Combined remaining capacity
includes the frozen original remainder; **new availability uses only the
supplement's remaining seven slots**. It never borrows legacy remainder.

## Local validation

The focused temporary-ledger suite is
`python3 -m unittest discover -s scripts -p test_provider_supplemental_budget.py`.
The gateway suite includes supplemental selection, pin rejection, exhaustion,
unchanged original bytes and exact recovery during suspension. These tests
create synthetic approval records only in disposable directories. They establish
no actual approval, new grant, provider spend, hosted recovery or AWS restore.
