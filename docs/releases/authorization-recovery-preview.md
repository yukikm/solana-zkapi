# Authorization recovery — SDK/native 0.2.0-devnet.10

This release builds on `.9` and recovers a never-admitted authorization without
clearing the deposit or changing its balance. It retains the `.9` timeout limits.
General JSON API onboarding work is not included in this client release.

## Recovery behavior

After an uncertain AUTH receives HTTP 409 during explicit `recover()`, the SDK
asks the updated server to permanently retire that exact request and quote.
The server verifies the saved proof, serializes against admission in the existing
ledger, commits an immutable fence and only then signs a recovery receipt.
The SDK verifies the receipt and archives the original authorization and previous
state in the encrypted journal. The balance remains unchanged and the next
explicit Send obtains a new quote/proof. If admission already won, the existing
session instead proceeds through normal settlement. Inference is never replayed.
An unavailable/older server or invalid receipt leaves the pending work intact.

Permanent withdrawal clearance is different: a note already cleared through
`reconcileUnacceptedAuthorization()` remains withdrawal-only. This release
cannot undo that operation or restore a cleared note to chat.

## Install and preserve existing custody

Download the SDK/native archives, manifest and `SHA256SUMS` from
[the `.10` release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.10).
Verify GitHub release/asset attestations and checksums. Distribution is through
GitHub assets, not the npm registry. Native scope remains macOS ARM64, macOS
13.5+, without Apple notarization.

```sh
shasum -a 256 -c SHA256SUMS
npm install --save-exact ./zkapi-solana-sdk-0.2.0-devnet.10.tgz @solana/kit@8.4.0
```

Keep the original installation, profile bytes/hash, storage name, account,
note ID, journal, keys, receipts and recovery material. `.10` explicitly accepts
authenticated `.8` and `.9` profiles without rewriting their bindings. Do not
select a new profile or replace custody as part of this update. Install native
binaries separately and retain a backup of the original journal; never run two
clients against the same custody concurrently. Once the new retirement archive
is written, older SDKs may reject the journal's additional recovery field; keep
using `.10` or a compatible successor to read it.

For new consumers the unchanged revision-7 profile remains compatible:

```json
{
  "schema": 2,
  "chain": "solana:devnet",
  "label": "Public Devnet — SDK .10 recovery",
  "profileUrl": "https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.9-r7.json",
  "profileSha256": "382cc3c5359a9a2fdcf67a7ae0524f26397e705055ff9105c95ca32ec3186fd3"
}
```

## Application and operator requirements

Applications such as zkchat must update their SDK dependency to `.10`, rebuild
both the application and prover-worker bundles and deploy them. Preserve the
existing funded profile and storage bindings; do not change them to the new-user
example above. The existing explicit `recover()` action gains this behavior.
Do not use permanent withdrawal clearance as a transient-error status check.
Updating the server alone cannot add the new recovery flow to an older app.

Operators must deploy migration 0003 and matching control/gateway support.
Retain the exact deployment keys, manifests, signer journal and financial ledger.
Backups and restore checkpoints must include acknowledged retirement fences;
never restore admission against a snapshot that omits them. See
[the protocol](../specs/api-proxy.md#retiring-a-never-admitted-authorization).
The current public server and this client release have separate source branches;
the release notes identify both exact commits. Local real-proof/PostgreSQL tests
and read-only public checks are separate from funded public inference acceptance.
No new funded lifecycle or mainnet/production support is implied.
