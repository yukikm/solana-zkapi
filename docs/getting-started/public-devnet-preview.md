# Public Devnet preview deployment

Use the published **SDK/native `0.2.0-devnet.8`** with the revision-6 profile for
new installations. See the [release guide](../releases/usability-preview.md) for
upgrade guidance. Existing notes must keep their original installation, profile,
custody and journal until recovery and closure are complete.

For native installation, follow [Install and run clientd](clientd.md). For an
application, use the [SDK quickstart](sdk.md).

The gateway permits any browser origin and does not require invitations. It uses
operator-funded usage without a fixed trial allowance; per-session caps and
note-balance checks remain. Check [service status](../status.md), fresh preflight,
`/relay-status` and `/provider-budget` before funding. Readiness does not establish
provider credit or guarantee inference. This preview has no uptime commitment.

## Current inputs for new consumers

The public API origin is `https://d366buuvadnp3.cloudfront.net`.
Browser requests use `credentials: "omit"`; HTTP localhost origins are allowed.
CORS allows access to responses, including errors, and does not establish service
readiness. The current downloads and independently reviewed hashes are:

| Input | SHA-256 |
|---|---|
| [Revision-6 profile](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.8-r6.json) | `ec10c1ab41bb5105222d3e25c7e1eba6b96b1b397abd0f854657030269992a77` |
| [SDK `.8` tarball](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.8/zkapi-solana-sdk-0.2.0-devnet.8.tgz) | `cd9226f4526c0b3561a557e4c7beb4f495dcbad6c995c624f4c442b6621414da` |
| [macOS ARM64 `.8` archive](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.8/zkapi-clientd-0.2.0-devnet.8-darwin-arm64.tar.gz) | `14154d038bc0e79347076b9983754eeca2fbde78159be21e5ca7b0cddca632ac` |
| Extracted native `.8` `release.json` | `20c194668cbb9b13fecf8170c709fb03dd055bbd1b67b93b6e652dcfe7d118be` |

Verify downloads against independently obtained pins. Native support is macOS
ARM64, macOS 13.5+, without Apple notarization. Gateway discovery still returns
an older profile; select the revision-6 input explicitly for a new `.8` installation.

## Connection and access

1. Obtain the profile and download pins above through a trusted channel.
2. Follow the [public-profile guide](../sdk/public-profile.md) for a browser app or
   [independent consumer guide](../../tools/public-devnet-consumer/README.md) for
   native setup files.
3. Run read-only preflight. It verifies deployment assets, genesis, the finalized
   Pool, control catalog and tree snapshot without creating custody, AUTH,
   inference or transactions.
4. Check `/relay-status` for admission policy and `/provider-budget` for the
   operator-funded or finite-allowance policy. Preflight does not reserve funds
   or check provider credit.
5. Follow the [funding guide](devnet-funding.md) once new usage is available.

A `snapshot` error means the chain snapshot could not be verified; it does not
indicate insufficient wallet balance. Keep the same profile and journal when
recovering an interrupted operation.

The profile uses direct OpenRouter Chat, a one-USDC session cap and at most
128 output tokens. Prompts go directly to OpenRouter; consumers do not supply
an OpenRouter management key. The configured model list is an immutable catalog
snapshot. [Selected OpenClaw cases](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md) have
live evidence; the expanded list has not been verified model by model.

When `/relay-status` reports `invitation_required: false`, omit native
`--admission-token-file` and browser `admissionToken`. Other deployments can
require an invitation; obtain it privately and keep it out of URLs, public
profiles and logs. Invitation policy does not override suspended admission or
provider limits.

The separate [browser app](https://d30nr98svcwdoe.cloudfront.net/releases/public-devnet-20261008-a/chat-en-sdk3/index-r2.html)
retains its earlier profile and release. Its page rendering has been checked;
current funded browser acceptance remains deferred. Its custody namespace is
`zkchat-sdk-0.2.0-devnet.3`; it does not migrate existing custody or profiles.

## Existing installations: .3 inputs

Keep these inputs with existing `.3` custody. Their model list and release are
unchanged; they are not the new `.8` installation inputs.

| Input | SHA-256 |
|---|---|
| [Revision-3 model profile for SDK .3](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-models-gpt56-claude5-r3.json) | `210bda7eb98fe902bf00194096355f5e3ac2ae79421477d4a9d2678b9faa1f6a` |
| [Preserved revision-2 profile for SDK .3](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.3.json) | `449657cc3fe90f12878236b83d68ada8077e3c56e67ccb8268c5f301e69e02e5` |
| Complete bundle descriptor | `10a85725034a18bfa3e07913af9cdf89bd10ca05c4ce50aefe5f766a2431c9c8` |
| [SDK .3 tarball](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.3/zkapi-solana-sdk-0.2.0-devnet.3.tgz) | `5dfa1d9edf58e6a8b3359cc16d29e55657b6c205e948b7ca1b7b40018e452887` |
| [macOS ARM64 native .3 archive](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.3/zkapi-clientd-0.2.0-devnet.3-darwin-arm64.tar.gz) | `e122202b6d6f58430baf818889edd7f7d9d46eee7dfee338996f8811e78f9762` |
| Extracted native `release.json` | `e066122897cfe694fd9b2541a95a6341d2ab6734be1ab34626470ba3ec01d20f` |
| [Public `release-manifest.json`](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.3/release-manifest.json) | `46409e47d440a8963f68c706660e00c0a804aabd817ca75a2cc961e37cfefab4` |

The immutable [GitHub prerelease](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.3)
provides the client archives through a separate authenticated publication channel.
Verify independently obtained pins before trusting downloads; a digest fetched
only beside its artifact is not an independent trust anchor. The native archive
targets macOS ARM64 and is not Apple notarized.

The profile authenticates the complete proof bundle, notices, WASM, model
restrictions and deployment. Its canonical manifest hash is
`b97e200769be24448a51999346a28d0ca497892d68212f517b2b9bb4cc1a4643`.
The Devnet program is `2sXbYtY2NbyGm1GeCETkkjAa5LxWCA8v8aj2ePW3yVDH`;
the Pool is `Cx8DbA49UCuASoc3goLCU9ro25eWVtcGMbvfPPJsSQzV`.
These identities must not replace those of an existing funded note.

## Existing installations: .2 inputs

These historical inputs remain unchanged. Preserve them with the original funded
note, journal, browser origin/account and private recovery configuration. Selecting
a newer SDK or app does not authorize changing an existing custody/profile binding.
The [original R2 app](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/chat-en-r2/index.html)
and [immutable .2 release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.2)
remain available; do not initialize replacement custody to recover existing funds.

| Input | SHA-256 |
|---|---|
| [Profile](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile.json) | `5e868f8e57ef06961b73ba8cb755635e81d4bb168dd6ad498152496ac1b02d14` |
| Complete bundle descriptor | `10a85725034a18bfa3e07913af9cdf89bd10ca05c4ce50aefe5f766a2431c9c8` |
| [SDK tarball](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/clients/zkapi-solana-sdk-0.2.0-devnet.2.tgz) | `fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc` |
| [macOS ARM64 native archive](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/clients/zkapi-clientd-0.2.0-devnet.2-darwin-arm64.tar.gz) | `9a2ab6759d99b3d7031b4c939ab654caeec2244763d1f16538e471bd5675cb56` |
| Extracted native `release.json` | `0b5733718f51eabcf4ca57f2406eb36bab641e23d642aac2436ca0e3090572ca` |

## Verification

[Support status](../status.md) summarizes native lifecycle, recovery, withdrawal
and browser verification limits. Release-specific changes and upgrade guidance
are in the [`.8` release notes](../releases/usability-preview.md). Operator incident
procedures are in the [operations guide](operators/incidents.md).
