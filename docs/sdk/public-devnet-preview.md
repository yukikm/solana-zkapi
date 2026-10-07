# Public Devnet preview deployment

Status at 2026-10-08 JST: **assets are published; public preflight and unfunded
browser/native initialization have passed; funded acceptance remains in
progress**. New admission is suspended at this checkpoint. A successful
download or read-only preflight is not a live-provider result. See the
[implementation record](../public-devnet-implementation.md) for current evidence.

The operator uses the AWS account selected by the repository maintainer. This is
an invitation-only, single-model Devnet preview with one operator host. It has
no production availability commitment. The current hosting target is roughly
USD50/month; that target is separate from the seven-USDC maximum provider
exposure authorized for the acceptance campaign. Reservations are maximum
exposure, not measured provider charges.

## Reviewed public inputs

The public API origin is `https://d366buuvadnp3.cloudfront.net`. The independent
[zkchat application](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/chat-en-r2/index.html)
uses the same immutable profile. Browser custody remains in that HTTPS origin
and browser profile; retain it through recovery and withdrawal.

| Input | SHA-256 |
|---|---|
| [Profile](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile.json) | `5e868f8e57ef06961b73ba8cb755635e81d4bb168dd6ad498152496ac1b02d14` |
| Complete bundle descriptor | `10a85725034a18bfa3e07913af9cdf89bd10ca05c4ce50aefe5f766a2431c9c8` |
| [SDK tarball](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/clients/zkapi-solana-sdk-0.2.0-devnet.2.tgz) | `fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc` |
| [macOS ARM64 native archive](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/clients/zkapi-clientd-0.2.0-devnet.2-darwin-arm64.tar.gz) | `9a2ab6759d99b3d7031b4c939ab654caeec2244763d1f16538e471bd5675cb56` |
| Extracted native `release.json` | `0b5733718f51eabcf4ca57f2406eb36bab641e23d642aac2436ca0e3090572ca` |

The immutable [GitHub release `v0.2.0-devnet.2`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.2)
publishes the same client archives and the profile pin above through a separate
authenticated channel. Release and client-asset attestations, anonymous downloads
and all native installed-file hashes passed
[publication verification](../evidence/PD-public-client-publication.md).
Verify the independently obtained pins before trusting downloads; a digest
fetched only beside its artifact is not an independent trust anchor. Earlier
immutable `.1` releases remain unchanged. The native archive targets macOS ARM64
and is not Apple notarized.

The profile authenticates the complete proof bundle, notices, WASM, model
restrictions and deployment. Its canonical manifest hash is
`b97e200769be24448a51999346a28d0ca497892d68212f517b2b9bb4cc1a4643`.
The Devnet program is `2sXbYtY2NbyGm1GeCETkkjAa5LxWCA8v8aj2ePW3yVDH`;
the Pool is `Cx8DbA49UCuASoc3goLCU9ro25eWVtcGMbvfPPJsSQzV`.
These identities must not replace those of an existing funded note.

## Connection and access

Follow the [public-profile guide](public-profile.md) for browser integration or
the [independent consumer instructions](../../tools/public-devnet-consumer/README.md)
for native input installation. Use the exact profile URL and digest above.
Read-only preflight downloads and verifies assets, genesis, finalized Pool,
control catalog and tree snapshot. It creates no custody, AUTH, inference or
transaction. A `snapshot` error means the selected chain snapshot could not be
verified; it is not evidence of insufficient wallet balance.

The reviewed configuration selects direct OpenRouter Chat with
`openai/gpt-4o-mini`, a maximum of 128 output tokens and a one-USDC authorization
cap. Prompts go directly to OpenRouter. Streaming and tools are implemented;
their current public live acceptance is still pending. Ordinary consumers do
not supply an OpenRouter management key.

Ask the deployment operator for an invitation through a private channel. New
AUTH requires it. The browser keeps it only in connection memory; native setup
reads an owner-only file and injects it only into the exact control AUTH route.
Do not publish invitations, add them to URLs, or store them in shared examples.
An invitation does not override suspended admission or create subsidy capacity.
Existing exact reserved AUTH, settlement, recovery and withdrawal retain their
original identity when new admission is suspended.

Funding requires the selected Circle **Devnet** USDC mint and Devnet SOL for
network fees. Read the [funding guide](devnet-funding.md). Test tokens do not pay
the operator's real provider bill. Keep the original note, journal, profile and
wallet during recovery; never resend inference automatically after uncertainty.

## Verified scope so far

Anonymous public downloads, complete installed native/WASM proof checks and
actual Chrome/native startup observations are recorded separately. The earlier
unavailable-snapshot diagnostic is preserved; later installed preflight and
Chrome connection checks passed. New browser storage and native custody were
initialized with zero balance and no AUTH, inference or wallet transaction.
Operator admission remained unverified by preflight. No funded browser/native
lifecycle or public provider success follows from these observations. See
[unfunded initialization](../evidence/PD-consumer-unfunded-startup.md),
[asset verification](../evidence/PD-public-assets.md),
[proof verification](../evidence/PD-public-bundle-download-proofs.md), and
[application publication](../evidence/PD-zkchat-english-publication.md).
