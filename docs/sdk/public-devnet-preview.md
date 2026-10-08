# Public Devnet preview deployment

Native closure checkpoint — 2026-10-08 14:27 UTC: [N-04 interrupted-stream recovery and mutual withdrawal](../evidence/PD-native-public-N04.md) are complete: one deliberate process-group kill, same-journal .3 restart, one explicit recovery, four independently verified signed settlements totaling **20 micro-USDC**, and return of **4,999,980 micro-USDC**. Six finalized exact-wire transactions establish the closed note and Vault zero; wallet equals treasury owner, so its restored balance does not erase charges. The final operator cut retains four full-cap reservations (4M micro-USDC exposure), four settled sessions and all 25 checkpoint rows. [OpenClaw text/read-tool continuation](../evidence/PD-native-public-N02-N03.md) passed in its separate scope; [external provider-cost reconciliation](../evidence/PD-openrouter-management-usage-limit.md) remains unresolved. [SDK .3 source CI](../evidence/PD-hosted-ci-e2ee932.md) passed all nine implementation jobs at exact source `e2ee9320…`, separate from live acceptance. Subsequent [independent backup verification](../evidence/PD-N01-backup-independent-verify.md) completed exact-version download, streamed archive checks and isolated PG16 logical restoration of the original one-session N01 cut; it does not restore the later four-session state or physical services. Funded browser cases, the separate zero-AUTH emergency exercise and deployed aggregate readiness remain unfinished. Preserve the interrupted response, all failed preparations/observations, immutable releases and original journals; no inference replay or chat-history restoration is implied.

New consumers should use the published **SDK/native `v0.2.0-devnet.3`**, its revision-2 profile, and the [independent browser app](https://d30nr98svcwdoe.cloudfront.net/releases/public-devnet-20261008-a/chat-en-sdk3/index-r2.html). [Release verification](../evidence/PD-sdk3-publication.md) records anonymous downloads and installed-file hashes; [browser publication](../evidence/PD-browser-sdk3-publication.md) records exact static bytes and Chrome page/settings rendering. Existing funded custody keeps its original profile, journal and recovery inputs. There is no automatic profile or custody migration.

Native N-01 completed Chat settlement and service recovery. [OpenClaw N-02/N-03](../evidence/PD-native-public-N02-N03.md) completed ordinary text and actual read-tool continuation, but their signed zero charges reflect selected management-usage snapshots; [external provider-cost reconciliation remains unverified](../evidence/PD-openrouter-management-usage-limit.md). N-04 recovery and withdrawal are now separately verified below. This invitation-only preview does not establish final-cost accuracy, funded browser acceptance or full release gates. Earlier checkpoints are retained below as historical observations, not current availability promises.

The operator uses the AWS account selected by the repository maintainer. This is
an invitation-only, single-model Devnet preview with one operator host. It has
no production availability commitment. The current hosting target is roughly
USD50/month; the current fixed illustration is USD39.969 for 730 hours, before
variable charges and actual taxes, after the same-volume expansion to 40 GiB
of durable data. That target is separate from the seven-USDC maximum provider
exposure authorized for the acceptance campaign. Reservations are maximum
exposure, not measured provider charges.

## Current inputs for new consumers

The public API origin is `https://d366buuvadnp3.cloudfront.net`. The independent
[SDK .3 app](https://d30nr98svcwdoe.cloudfront.net/releases/public-devnet-20261008-a/chat-en-sdk3/index-r2.html)
uses its separate HTTPS origin and explicit new custody namespace
`zkchat-sdk-0.2.0-devnet.3`. Opening it does not migrate existing browser custody.

| Input | SHA-256 |
|---|---|
| [Revision-2 profile for SDK .3](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.3.json) | `449657cc3fe90f12878236b83d68ada8077e3c56e67ccb8268c5f301e69e02e5` |
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

## Preserved .2 inputs for existing custody

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

## Connection and access

Follow the [public-profile guide](public-profile.md) for browser integration or
the [independent consumer instructions](../../tools/public-devnet-consumer/README.md)
for native input installation. New consumers use the .3 profile URL and digest above; existing custody retains its original inputs.
Read-only preflight downloads and verifies assets, genesis, finalized Pool,
control catalog and tree snapshot. It creates no custody, AUTH, inference or
transaction. A `snapshot` error means the selected chain snapshot could not be
verified; it is not evidence of insufficient wallet balance.

The reviewed configuration selects direct OpenRouter Chat with
`openai/gpt-4o-mini`, a maximum of 128 output tokens and a one-USDC authorization
cap. Prompts go directly to OpenRouter. Native OpenClaw text, streaming and read-tool continuation have their own
[recorded scope](../evidence/PD-native-public-N02-N03.md); funded browser acceptance
and external provider-cost reconciliation remain unverified. Ordinary consumers do
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

The current release/profile and independent app have separate download, installed-file
and page-rendering evidence. Earlier [unfunded initialization](../evidence/PD-consumer-unfunded-startup.md),
[public proof checks](../evidence/PD-public-bundle-download-proofs.md) and
[independent-origin preflight](../evidence/PD-public-runtime-origin-followup.md)
retain their original source/profile scope; the new .3 page rendering does not
repeat those checks or establish funded browser acceptance.

[Native N-01](../evidence/PD-native-public-N01.md) established its deposit, one Chat
response and signed six-micro-USDC charge. [Service recovery](../evidence/PD-N01-service-recovery.md)
records encrypted capture, same-state restart and later admission resume, while
independent backup restoration remains unverified. The later N-02/N-03 results
and management-usage limitation are linked above; their observations do not
establish reconciled provider billing or the remaining lifecycle cases.

## Historical checkpoints

The following dated text is preserved verbatim from earlier handoffs. It records
what was known at each checkpoint and is superseded by the current selection and
scoped results above.

Resume checkpoint — 2026-10-08 11:45 UTC: **admission resume completed**, followed by public HTTP 200 reporting admission and recovery enabled. The [service-recovery record](../evidence/PD-N01-service-recovery.md) joins the successful run06 to fresh installed-native preflight and two unchanged full local readiness checks; public `/relay-status` remains configuration-only. The pre-resume financial cut retained one N-01 full-cap reservation, the verified six-micro-USDC charge and active signed balance of 4,999,994 micro-USDC. Earlier attempts01–05 and all capture/restart/decoder failures remain preserved. This is a dated checkpoint, not a current balance or continuous-availability claim. Root launched N-02/N-03 around 11:48 UTC; their outcomes and any later reservations or charges are not included here. N-04, funded browser acceptance, withdrawal and independent backup restoration remain unverified. The readiness control candidate is still undeployed.

Latest handoff — 2026-10-08 10:55 UTC: **the writer correction is deployed; fresh readiness and admission resume remain unverified**. The [application-log correction](../evidence/PD-rpc-program-log.md) records the actual writer-only installation/start of binary `23bbb73fe88fcb111a1ca090cabe9cb0233693e09c9e2fc0d70b790f3b83b372`. Its start receipt records cold validation/replay in progress. The earlier executable, archive, configuration, other five processes and financial rows were preserved. Admission is false. N-01 retains one full-cap reservation, its verified six-micro-USDC charge and active signed balance of 4,999,994 micro-USDC; N-02–N-04, funded browser acceptance and withdrawal remain pending.

[Hosted implementation CI at `27ef2a4`](../evidence/PD-hosted-ci-27ef2.md) passed all nine jobs. At the latest root-saved cut, successor `e36cfbcd…` had eight successful jobs and client/challenger pending; no full successor CI success is claimed. The Linux readiness candidate remains undeployed. Earlier dated observations below retain their original scope and are not current availability guarantees.

Latest observed status — 2026-10-08 09:40:40 UTC: **cold replay ended, but new
admission is still suspended because the writer is blocked on archive decoding**.
The [recovery record](../evidence/PD-N01-service-recovery.md) retains the successful
encrypted capture and same-state restart. A later fresh health cut is non-ready
at durable tail `508763135`, with repeated `RPC archive encoding` errors. The
actual next block response and frozen old native reproduction identify application
`Program log: ` text containing ` failed:` being mistaken for runtime completion.
A narrow namespace correction is under local verification, with no deployed
correction claimed. N-01 remains settled with its active note and the
same one reservation, six-micro-USDC charge and signed 4,999,994-micro-USDC balance.
No additional paid case, funded browser acceptance or withdrawal has run.

At the root-saved CI cut around 10:05 UTC, successor run `37755041914` at `27ef2a4c…`
had eight successful jobs and client/challenger still running. The completed
nine-job success remains scoped to [source `1a25289`](../evidence/PD-hosted-ci-1a252.md).
The Linux readiness candidate remains built but undeployed. Earlier checkpoints
below describe their recorded times rather than current availability.

Current checkpoint — 2026-10-08 09:22 UTC: **encrypted capture and the guarded
same-state restart completed; fresh readiness and new admission remain pending**.
The [recovery record](../evidence/PD-N01-service-recovery.md) preserves the original
capture failure, explicit continuation and exact receipts. At 09:01, all six
services were active with zero automatic restarts and the original archive
follower unchanged. The writer was still replaying its journal with stale,
non-ready health. New admission is false. N-01 remains one reservation and a
verified six-micro-USDC charge; the active note's signed balance is 4,999,994
micro-USDC. N-02–N-04, funded browser acceptance and withdrawal remain pending.
The encrypted upload was confirmed by its response checksum and version;
independent download, decryption and restore have not been tested.

The [readiness candidate](../evidence/PD-public-readiness-candidate.md) and
[OpenClaw settlement adapter](../evidence/PD-openclaw-settlement-adapter.md) are
published in the 24-path source follow-up at
[`27ef2a4c842927240e0fae776a5017a46b6c141d`](https://github.com/yukikm/solana-zkapi/commit/27ef2a4c842927240e0fae776a5017a46b6c141d).
The Linux control candidate (`505b7e65…20c36a7`) is built but not deployed; the
adapter has local fixture evidence, not funded OpenClaw acceptance.
[Implementation CI at `1a25289`](../evidence/PD-hosted-ci-1a252.md) passed all nine
jobs. Successor [run 37755041914](https://github.com/yukikm/solana-zkapi/actions/runs/37755041914)
was still running with four of nine jobs successful at 09:21 UTC. That is not a
success claim for the new source. Original releases, ledger, custody and archive
anchors remain preserved. Earlier dated checkpoints follow.

Checkpoint through 2026-10-08 06:54:45 UTC: **public responses,
independent-origin Chrome preflight/worker execution and installed-native
preflight passed. Native N-01 completed a deposit, Chat response and signed
settlement; the full funded lifecycle remains unfinished**. The supplied Helius
Devnet RPC is configured. The [runtime follow-up](../evidence/PD-public-runtime-origin-followup.md)
records the later successful responses after the earlier
[decoder correction](../evidence/PD-rpc-log-truncation.md) and follower replay.
The [admission recovery checkpoint](../evidence/PD-public-admission-recovery.md)
records the preserved failed policy check and the successful explicit continuation
at 06:20 UTC. Public status then reported admission and recovery enabled with
zero reservations. The first native deposit preparation failed before funding
because its wallet read route was blocked. The subsequent
[route correction](../evidence/PD-public-wallet-route-fix.md) and
[N-01 acceptance](../evidence/PD-native-public-N01.md) establish the later
successful deposit and six-micro-USDC metered charge. The note remains active;
service recovery, additional conversations, withdrawal and funded browser
acceptance are unfinished. The
[migration/storage checkpoint](../evidence/PD-rpc-migration-startup.md) records
the actual configuration change, retained history and 20-to-40-GiB data expansion.
The [earlier quota and free-endpoint failures](../evidence/PD-public-rpc-quota-blocker.md)
remain preserved. Earlier download or preflight success is not current availability.
See the [implementation record](../public-devnet-implementation.md) for other scopes.

### Earlier verified-scope text

Anonymous public downloads, complete installed native/WASM proof checks and
actual Chrome/native startup observations are recorded separately. The earlier
unavailable-snapshot diagnostic is preserved; later installed preflight and
Chrome connection checks passed. New browser storage and native custody were
initialized with zero balance and no AUTH, inference or wallet transaction.
Operator admission remained unverified by those preflight observations. See
[unfunded initialization](../evidence/PD-consumer-unfunded-startup.md),
[asset verification](../evidence/PD-public-assets.md),
[proof verification](../evidence/PD-public-bundle-download-proofs.md), and
[application publication](../evidence/PD-zkchat-english-publication.md).

The later [native N-01 result](../evidence/PD-native-public-N01.md) used the
immutable installed release and stock supervisor/Go egress through the public
HTTPS service. Its five-USDC Devnet deposit finalized in one 995-byte
transaction. One Chat response completed, and the SDK verified a signed
six-micro-USDC charge and remaining balance of 4,999,994 micro-USDC. This
establishes that case only. The note is still active, and ordinary withdrawal,
service restart, interrupted-session recovery, OpenClaw tool continuation and
funded browser acceptance are pending.
