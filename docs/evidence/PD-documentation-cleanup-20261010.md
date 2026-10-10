# Documentation cleanup — 2026-10-10 JST

The README and SDK guides were shortened to separate integration instructions
from operational history. Publication was prepared on `129aa9d` after reading
the newer `.6`–`.8` release records on main. Current guides retain the `.8`
release, its public catalog/preflight failure, exhausted provider allowance and
original-custody requirements. This edit changes documentation only.

Existing evidence and acceptance checklists remain unchanged. The excerpts below
preserve earlier handoffs, including failures, receipt identifiers and statements
superseded by later observations. Their prose is unchanged; relative links are
rebased to this file. They are historical records, not current service status.

## Documentation checks

- `python3 scripts/check_design.py`: passed after initializing the worktree's
  pinned upstream submodule. The first run found four links into that absent
  submodule; no documentation or runtime change was needed to resolve them.
- `git diff --check`: passed. Local link/anchor checks covered the 15 edited
  guides and this archive. All 12 earlier download/profile pins are unchanged;
  four `.8` pins match the existing publication record.
- Existing evidence and runtime files are unchanged. Guide text decreased from
  15,553 to 11,289 whitespace-delimited words, excluding this archive.
  Runtime tests and live acceptance were not rerun.

Aggregate SHA-256 of sorted `file-sha256  path` lines for the 15 guides:

- Before: `2fe79a181b25b41e687625697e14ab4243300acd1b3bcec51337c8b67a473051`
- After: `25604e4fcb4ab081818a6c02aaf4cce4beaa848e508b4f483e4216c8ba1887ea`

## Archived handoffs

<details>
<summary>README release notices (README.md)</summary>

[Privacy and recovery usability `.8` is published](PD-sdk8-publication-20261010.md):
read-only upgrade plans, explicit ZDR model checks and structured privacy status.
Both client CI jobs, 543 source tests, 224 installed-package tests and all six
asset attestations/downloads passed. See the [`.8` guide](../releases/usability-preview.md)
for the new revision-6 profile and safe handling of older installations.
**Public preflight is currently blocked:** the operator catalog returned an empty
model list on both `.7` and `.8`. New ZDR metadata checks passed separately; this
does not establish public inference readiness. The evidence preserves both results.

[Privacy release verified](PD-sdk7-publication-20261010.md): SDK/native
**`0.2.0-devnet.7`** adds direct-request filtering, direct OpenRouter ZDR policy and
request-journal minimization. See the [release guide](../releases/privacy-preview.md)
for downloads and the immutable revision-5 profile. Both client CI jobs, 528 local
source tests, 209 installed-package tests and all six asset attestations/downloads
passed. Full implementation CI was still running at the recorded cut. Existing
custody keeps its original profile and recovery inputs.

[Publication verified](PD-sdk6-publication-20261009.md): SDK/native `.6`, both client-preview CI jobs,
six anonymous asset downloads and all release/asset attestations passed. Full
implementation CI was still running at the recorded release cut.

Earlier SDK/native **`0.2.0-devnet.6`** consumers: see the [session reuse release guide](../releases/session-reuse-preview.md)
for exact downloads and the compatible immutable revision-4 profile. Existing
`.3` installations retain their original profile and recovery inputs.

The [requested GPT 5.6+ / Claude 5+ model expansion](PD-model-expansion-20261009.md) is deployed with 21 OpenRouter Chat models and a [revision-3 consumer profile](../sdk/public-models.md). SDK/native remain `.3`. Existing seven request reservations are exhausted; this configuration change adds no provider budget. Old custody/profile bindings remain unchanged.

</details>

<details>
<summary>README handoff (README.md)</summary>

## Current handoff — 2026-10-09 JST

The [v0.2.0-devnet.5 API source release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.5) publishes the deployed CORS change at `e1da525`. Source, signatures and anonymous downloads are [verified](PD-cors-release-20261009.md). SDK/native remain `.3`; full CI was still running at the recorded cut.

The public API now [allows any browser origin](PD-public-cors-20261009.md), including HTTP localhost, without origin registration. The ZKAPI-only gateway change is deployed; actual Chromium config and read-only RPC calls passed from independent HTTPS and localhost origins. Use `credentials: "omit"` (already used by SDK `.3`). Separate tree-root HTTP503 responses were observed and remain unresolved; CORS now allows applications to read those errors.

The [Indexer incident repair](PD-indexer-recovery-20261009.md) is installed as `b88226ba…77284`. Public readiness returned HTTP 200 at **03:20:08 UTC**, and all ten installed SDK `.3` preflight checks passed. The mutable-head read race is reproduced and fixed; the original low-level failure was not retained by the old logs. Only the Indexer restarted, once; writer, financial state and reservations were preserved.

The [v0.2.0-devnet.4 API source release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.4)
is published and verified. SDK/native clients remain `0.2.0-devnet.3`; see the
[publication record](PD-invitation-release-20261009.md).

The public API is now configured to accept new AUTH without an invitation, within the existing
finite provider budget. The [gateway update](PD-invitation-removal-20261009.md)
preserves session authentication, proof checks, reservations and recovery. This
is an API-only change; independent chat applications retain their own releases.

The core SDK/API, Ethereum-style history restart and OpenRouter accounting are
installed and verified in the selected Devnet preview scope. The
[completion record](PD-core-completion-20261009.md) joins their
evidence. Demo UI work and long-term qualification are deferred.

- **Accounting:** the installed [Ethereum-parity implementation](PD-openrouter-ethereum-parity.md) disables the managed key, waits five seconds, captures one valid management `usage + byok_usage` observation, persists it, and confirms deletion before capped settlement. Captured amounts survive recovery; signed charges are never repriced. Delayed provider accounting remains the operator's risk, without a final-invoice accuracy claim.
- **History:** [durable checkpoints](PD-restart-checkpoints.md) retain complete replay state and cursor, authenticate the suffix on normal restart, and fall back to full replay for a missing or invalid cache. The [actual warm restart](PD-warm-restart-20261009.md) verified both caches and bounded process reads with binary `0037eca8…7c8f49`. The observed 57.85/54.71-second intervals are upper bounds to the cache measurement, not precise cache-load times.
- **Writer and public API:** the [throughput correction](PD-replay-writer-deployment-20261009.md) is installed as `8ebeef10…89274`; the follower was `0037eca8…7c8f49` at that checkpoint and is now superseded by the [Indexer repair](PD-indexer-recovery-20261009.md). Its 194 build inputs match published source `8423687b…`. [Public restoration](PD-public-restoration-20261009.md) completed at 00:54 UTC, followed by fresh public HTTP 200 and all ten installed `.3` preflight checks. The complete financial database and four existing reservations remained unchanged.

**Core completion checks:**

- [x] Fresh finalized reconciliation, guarded gateway start against the installed cut, public readiness and installed SDK preflight are [recorded](PD-public-restoration-20261009.md). Admission/recovery were separately observed enabled; provider credit and continuous availability are not established by these checks.
- [x] [E01 emergency withdrawal](PD-E01-emergency-withdrawal-20261009.md) completed from its original deposit and journal: seven exact-wire finalized transactions, one micro-USDC returned, the Note closed and `Pending.exists=false`. The saved journal has zero AUTH; the four-session/four-reservation operator cut is unchanged. Public readiness was freshly verified again at 01:43:23 UTC.
- [x] Final readiness, E01 outcomes and the updated handoff are linked and versioned in this documentation update. [Source publication and CI](PD-hosted-ci-7700493.md) retain their exact recorded scopes; latest-source hosted CI is still in progress.

Browser work and additional lifecycle/recovery acceptance are deferred. See the
[core scope](PD-core-scope-reconciliation.md) and
[readiness backlog](../public-devnet-readiness-backlog.md) for their separate
boundaries. Preserve existing journals, signed attempts, reservations, immutable
releases and failed observations.

**AWS cost status:** read-only AWS inspection at 2026-10-09 00:15:55 UTC
confirmed `t3a.medium`, Standard CPU credits, an 80 GiB gp3 data volume and a
20 GiB gp3 root volume. This inspection changed no resources. The 80 GiB data
volume remains retained; its additional 40 GiB has an illustrative cost of
USD 3.20/month. Returning to 40 GiB is an unresolved storage follow-up requiring
a verified migration, not a completed rollback or deletion of retained history.
The [retained-capacity record](PD-capacity-retained-20261009.md)
measured 30,190,022,656 bytes available at 00:25:35 UTC; retained archive data
already exceeds 40 GiB. No migration or new storage decision is implied, and
continued chain growth leaves long-term capacity qualification deferred.
See the [earlier expansion record](PD-preview-capacity-80g.md) and
[AWS's restriction on shrinking volumes](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-modify-volume.html).

**Development preview.** Local protocol tests and selected Devnet/provider demos
have passed. Independent SDK installation and selected devnet/provider lifecycles
also have [separate evidence](I10-external-integration.md). Full provider
acceptance, production setup, audits and release gates remain incomplete.
The [public-profile client release](PD-sdk3-publication.md)
provides an SDK tarball and a macOS ARM64 clientd distribution.
There is no published npm release or ready-to-use production deployment bundle.
See [supported features and evidence](../sdk/status.md).

The [public Devnet readiness backlog](../public-devnet-readiness-backlog.md)
separates completed public inputs, services, native acceptance and E01 emergency
withdrawal and the published evidence handoff from deferred broader work.
The published `0.2.0-devnet.3` preview provides an
[authenticated public profile and read-only preflight](../sdk/public-profile.md),
an [independent consumer example](../../tools/public-devnet-consumer/README.md),
and [funding instructions](../sdk/devnet-funding.md).
See the [implementation record](../public-devnet-implementation.md) for the
original design and acceptance boundaries. The
[public deployment guide](../sdk/public-devnet-preview.md) supplies the actual
profile and verified downloads. The [restoration record](PD-public-restoration-20261009.md)
includes successful installed preflight at 00:55:26 UTC on 2026-10-09. The
[completion record](PD-core-completion-20261009.md) adds fresh public
readiness at 01:43:23 UTC after E01. Run fresh preflight before use; these observations
do not guarantee continuous availability.

[Kit migration](../sdk/kit-migration.md) · [SDK quickstart](../sdk/quickstart.md) · [SDK tarball](../sdk/distribution.md) · [Local clientd](../sdk/clientd-quickstart.md)

The current source and published `0.2.0-devnet.3` use `@solana/kit` 8.4.0 throughout the
SDK and native client. Its native Kit API is a breaking change from the first
preview; follow the [migration guide](../sdk/kit-migration.md). The existing
immutable `v0.1.0-devnet.1` release remains historical.
[`v0.2.0-devnet.3`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.3)
is published; [signature and anonymous-download verification](PD-sdk3-publication.json)
identify the exact released files.

The [Ethereum lease-reuse follow-up](PD-session-reuse-20261009.md)
updates the application SDK to reuse direct sessions and settle groups of requests.

</details>

<details>
<summary>Public preview handoffs (docs/sdk/public-devnet-preview.md)</summary>

New SDK/native **`0.2.0-devnet.6`** consumers: see the [session reuse release guide](../releases/session-reuse-preview.md)
for exact downloads and the compatible immutable revision-4 profile. Existing
`.3` installations retain their original profile and recovery inputs.

Model expansion — 2026-10-09: the [revision-3 model profile](../sdk/public-models.md) selects 21 OpenRouter Chat models covering GPT 5.6+ and Claude 5+. SDK/native stay `.3`; consumers install the new profile URL and digest. Existing custody retains its original inputs. The existing seven request reservations are exhausted; this model change does not add spending capacity.

The [v0.2.0-devnet.5 API source release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.5)
publishes the deployed CORS opening. SDK/native artifacts remain `0.2.0-devnet.3`;
no client upgrade is required. [Publication evidence](PD-cors-release-20261009.md).

Access update — 2026-10-09: the [public API invitation requirement was removed](PD-invitation-removal-20261009.md).
The installed gateway reports `invitation_required: false`; SDK/native consumers
can omit the invitation. Authentication, proofs, finite provider budget and
recovery remain enforced. Independent application releases are separate.

Current completion checkpoint — 2026-10-09 JST: [public restoration](PD-public-restoration-20261009.md) completed the guarded gateway start after fresh finalized reconciliation. Installed `.3` preflight passed ten checks at 00:55:26 UTC with all 7,257 files unchanged and no AUTH, inference or wallet action. [E01 emergency withdrawal](PD-E01-emergency-withdrawal-20261009.md) then completed from the original deposit/journal: seven exact-wire finalized transactions, one micro-USDC returned, Note closed and `Pending.exists=false`, with zero AUTH in its journal and the complete operator financial cut unchanged. The [core completion record](PD-core-completion-20261009.md) records fresh public HTTP 200 at 01:43:23 UTC and separately enabled admission/recovery. This follows the installed [Ethereum OpenRouter capture policy](PD-openrouter-ethereum-parity.md), [verified warm restart](PD-warm-restart-20261009.md) and [writer throughput successor](PD-replay-writer-deployment-20261009.md). Final evidence is linked and versioned in this documentation update. The `.3` inputs below stay current; run fresh preflight before use. Earlier dated checkpoints remain historical observations, not continuous-availability guarantees.

Readiness checkpoint — 2026-10-08 15:16 UTC: [the public readiness endpoint is deployed and admission resumed](PD-public-readiness-deployment.md). It reports control/indexer/signer capabilities with a five-second expiry; provider credit and admission are explicitly `not_checked`, with admission reported separately by relay configuration. The first indexer-unavailable HTTP503 and later successful samples remain distinct; continuous availability and final provider-cost accuracy are not established. Funded browser cases, E01 and planned 80 GiB expansion remain outside this checkpoint.

Native closure checkpoint — 2026-10-08 14:27 UTC: [N-04 interrupted-stream recovery and mutual withdrawal](PD-native-public-N04.md) are complete: one deliberate process-group kill, same-journal .3 restart, one explicit recovery, four independently verified signed settlements totaling **20 micro-USDC**, and return of **4,999,980 micro-USDC**. Six finalized exact-wire transactions establish the closed note and Vault zero; wallet equals treasury owner, so its restored balance does not erase charges. The final operator cut retains four full-cap reservations (4M micro-USDC exposure), four settled sessions and all 25 checkpoint rows. [OpenClaw text/read-tool continuation](PD-native-public-N02-N03.md) passed in its separate scope; [external provider-cost reconciliation](PD-openrouter-management-usage-limit.md) remains unresolved. [SDK .3 source CI](PD-hosted-ci-e2ee932.md) passed all nine implementation jobs at exact source `e2ee9320…`, separate from live acceptance. Subsequent [independent backup verification](PD-N01-backup-independent-verify.md) completed exact-version download, streamed archive checks and isolated PG16 logical restoration of the original one-session N01 cut; it does not restore the later four-session state or physical services. Funded browser cases, the separate zero-AUTH emergency exercise and deployed aggregate readiness remain unfinished. Preserve the interrupted response, all failed preparations/observations, immutable releases and original journals; no inference replay or chat-history restoration is implied.

New API consumers should use the published **SDK/native `v0.2.0-devnet.3`** with the [revision-3 model profile](../sdk/public-models.md). The [independent browser app](https://d30nr98svcwdoe.cloudfront.net/releases/public-devnet-20261008-a/chat-en-sdk3/index-r2.html) retains its earlier profile and separate release. [Release verification](PD-sdk3-publication.md) records anonymous downloads and installed-file hashes; [browser publication](PD-browser-sdk3-publication.md) records exact static bytes and Chrome page/settings rendering. Existing funded custody keeps its original profile, journal and recovery inputs. There is no automatic profile or custody migration.

Native N-01 completed Chat settlement and service recovery. [OpenClaw N-02/N-03](PD-native-public-N02-N03.md) completed ordinary text and read-tool continuation; [N-04](PD-native-public-N04.md) completed interrupted-stream recovery and mutual withdrawal. The installed [Ethereum-style accounting policy](PD-openrouter-ethereum-parity.md) accepts delayed provider accounting as the operator's risk. The [historical response-cost discrepancy](PD-openrouter-management-usage-limit.md) and signed zero charges remain preserved without repricing. This Devnet preview does not establish invoice-finality, funded browser acceptance or full release gates.

The operator uses the AWS account selected by the repository maintainer. This is
a Devnet preview with one operator host and a finite provider budget. It has
no production availability commitment. The current hosting target is roughly
USD50/month; the current fixed illustration is USD43.169 for 730 hours, before
variable charges and actual taxes, after the [same-volume expansion to 80 GiB](PD-preview-capacity-80g.md)
of durable data. That target is separate from the seven-USDC maximum provider
exposure authorized for the acceptance campaign. Reservations are maximum
exposure, not measured provider charges.

</details>

<details>
<summary>Public preview verification and history (docs/sdk/public-devnet-preview.md)</summary>

## Verified scope so far

The [2026-10-09 restoration](PD-public-restoration-20261009.md)
records the later public readiness and installed `.3` preflight against these
inputs. It preserves three earlier pre-start failures and the complete financial
cut. The [retained-capacity record](PD-capacity-retained-20261009.md)
confirms 80 GiB data/20 GiB root and unchanged `t3a.medium` Standard credits,
with 30,190,022,656 available bytes at 00:25:35 UTC. Retained archive data exceeds
40 GiB; no migration or rollback occurred, and long-term qualification is deferred.

The current release/profile and independent app have separate download, installed-file
and page-rendering evidence. Earlier [unfunded initialization](PD-consumer-unfunded-startup.md),
[public proof checks](PD-public-bundle-download-proofs.md) and
[independent-origin preflight](PD-public-runtime-origin-followup.md)
retain their original source/profile scope; the new .3 page rendering does not
repeat those checks or establish funded browser acceptance.

[Native N-01](PD-native-public-N01.md) established its deposit, one Chat
response and signed six-micro-USDC charge. [Service recovery](PD-N01-service-recovery.md)
records encrypted capture, same-state restart and later admission resume.
[Independent backup verification](PD-N01-backup-independent-verify.md)
subsequently verified the exact uploaded version and isolated PostgreSQL logical
restoration of the original one-session N-01 cut. It does not restore the later
four-session financial cut or physical services. The later N-02/N-03/N-04
results and accounting limitation retain their separate scopes above.

## Historical checkpoints

The following dated text is preserved verbatim from earlier handoffs. It records
what was known at each checkpoint and is superseded by the current selection and
scoped results above.

Resume checkpoint — 2026-10-08 11:45 UTC: **admission resume completed**, followed by public HTTP 200 reporting admission and recovery enabled. The [service-recovery record](PD-N01-service-recovery.md) joins the successful run06 to fresh installed-native preflight and two unchanged full local readiness checks; public `/relay-status` remains configuration-only. The pre-resume financial cut retained one N-01 full-cap reservation, the verified six-micro-USDC charge and active signed balance of 4,999,994 micro-USDC. Earlier attempts01–05 and all capture/restart/decoder failures remain preserved. This is a dated checkpoint, not a current balance or continuous-availability claim. Root launched N-02/N-03 around 11:48 UTC; their outcomes and any later reservations or charges are not included here. N-04, funded browser acceptance, withdrawal and independent backup restoration remain unverified. The readiness control candidate is still undeployed.

Latest handoff — 2026-10-08 10:55 UTC: **the writer correction is deployed; fresh readiness and admission resume remain unverified**. The [application-log correction](PD-rpc-program-log.md) records the actual writer-only installation/start of binary `23bbb73fe88fcb111a1ca090cabe9cb0233693e09c9e2fc0d70b790f3b83b372`. Its start receipt records cold validation/replay in progress. The earlier executable, archive, configuration, other five processes and financial rows were preserved. Admission is false. N-01 retains one full-cap reservation, its verified six-micro-USDC charge and active signed balance of 4,999,994 micro-USDC; N-02–N-04, funded browser acceptance and withdrawal remain pending.

[Hosted implementation CI at `27ef2a4`](PD-hosted-ci-27ef2.md) passed all nine jobs. At the latest root-saved cut, successor `e36cfbcd…` had eight successful jobs and client/challenger pending; no full successor CI success is claimed. The Linux readiness candidate remains undeployed. Earlier dated observations below retain their original scope and are not current availability guarantees.

Latest observed status — 2026-10-08 09:40:40 UTC: **cold replay ended, but new
admission is still suspended because the writer is blocked on archive decoding**.
The [recovery record](PD-N01-service-recovery.md) retains the successful
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
nine-job success remains scoped to [source `1a25289`](PD-hosted-ci-1a252.md).
The Linux readiness candidate remains built but undeployed. Earlier checkpoints
below describe their recorded times rather than current availability.

Current checkpoint — 2026-10-08 09:22 UTC: **encrypted capture and the guarded
same-state restart completed; fresh readiness and new admission remain pending**.
The [recovery record](PD-N01-service-recovery.md) preserves the original
capture failure, explicit continuation and exact receipts. At 09:01, all six
services were active with zero automatic restarts and the original archive
follower unchanged. The writer was still replaying its journal with stale,
non-ready health. New admission is false. N-01 remains one reservation and a
verified six-micro-USDC charge; the active note's signed balance is 4,999,994
micro-USDC. N-02–N-04, funded browser acceptance and withdrawal remain pending.
The encrypted upload was confirmed by its response checksum and version;
independent download, decryption and restore have not been tested.

The [readiness candidate](PD-public-readiness-candidate.md) and
[OpenClaw settlement adapter](PD-openclaw-settlement-adapter.md) are
published in the 24-path source follow-up at
[`27ef2a4c842927240e0fae776a5017a46b6c141d`](https://github.com/yukikm/solana-zkapi/commit/27ef2a4c842927240e0fae776a5017a46b6c141d).
The Linux control candidate (`505b7e65…20c36a7`) is built but not deployed; the
adapter has local fixture evidence, not funded OpenClaw acceptance.
[Implementation CI at `1a25289`](PD-hosted-ci-1a252.md) passed all nine
jobs. Successor [run 37755041914](https://github.com/yukikm/solana-zkapi/actions/runs/37755041914)
was still running with four of nine jobs successful at 09:21 UTC. That is not a
success claim for the new source. Original releases, ledger, custody and archive
anchors remain preserved. Earlier dated checkpoints follow.

Checkpoint through 2026-10-08 06:54:45 UTC: **public responses,
independent-origin Chrome preflight/worker execution and installed-native
preflight passed. Native N-01 completed a deposit, Chat response and signed
settlement; the full funded lifecycle remains unfinished**. The supplied Helius
Devnet RPC is configured. The [runtime follow-up](PD-public-runtime-origin-followup.md)
records the later successful responses after the earlier
[decoder correction](PD-rpc-log-truncation.md) and follower replay.
The [admission recovery checkpoint](PD-public-admission-recovery.md)
records the preserved failed policy check and the successful explicit continuation
at 06:20 UTC. Public status then reported admission and recovery enabled with
zero reservations. The first native deposit preparation failed before funding
because its wallet read route was blocked. The subsequent
[route correction](PD-public-wallet-route-fix.md) and
[N-01 acceptance](PD-native-public-N01.md) establish the later
successful deposit and six-micro-USDC metered charge. The note remains active;
service recovery, additional conversations, withdrawal and funded browser
acceptance are unfinished. The
[migration/storage checkpoint](PD-rpc-migration-startup.md) records
the actual configuration change, retained history and 20-to-40-GiB data expansion.
The [earlier quota and free-endpoint failures](PD-public-rpc-quota-blocker.md)
remain preserved. Earlier download or preflight success is not current availability.
See the [implementation record](../public-devnet-implementation.md) for other scopes.

### Earlier verified-scope text

Anonymous public downloads, complete installed native/WASM proof checks and
actual Chrome/native startup observations are recorded separately. The earlier
unavailable-snapshot diagnostic is preserved; later installed preflight and
Chrome connection checks passed. New browser storage and native custody were
initialized with zero balance and no AUTH, inference or wallet transaction.
Operator admission remained unverified by those preflight observations. See
[unfunded initialization](PD-consumer-unfunded-startup.md),
[asset verification](PD-public-assets.md),
[proof verification](PD-public-bundle-download-proofs.md), and
[application publication](PD-zkchat-english-publication.md).

The later [native N-01 result](PD-native-public-N01.md) used the
immutable installed release and stock supervisor/Go egress through the public
HTTPS service. Its five-USDC Devnet deposit finalized in one 995-byte
transaction. One Chat response completed, and the SDK verified a signed
six-micro-USDC charge and remaining balance of 4,999,994 micro-USDC. This
establishes that case only. The note is still active, and ordinary withdrawal,
service restart, interrupted-session recovery, OpenClaw tool continuation and
funded browser acceptance are pending.

</details>

<details>
<summary>Operator checkpoints (docs/sdk/public-devnet-operations.md)</summary>

## Dated operational checkpoints

These observations do not establish availability at the time of reading:

| UTC checkpoint on 2026-10-08 | Established scope |
|---|---|
| 06:54 | [Native N-01](PD-native-public-N01.md) completed a finalized Devnet deposit, one Chat response and SDK-verified settlement. Its note remained active with 4,999,994 micro-USDC. |
| 07:43 | The [read-only operator join](PD-N01-operator-join.md) matched the exact AUTH, retained reservation and signed charge. The following local draft assembly failed; that report did not approve a suspension. |
| 07:58 | A later approved suspension changed only `allowNewAdmissions` to false and retained the one reservation. A public status read at 07:58:49 UTC returned HTTP200, `admission: suspended` and `recovery: enabled`. |

The retained suspension result has SHA-256
`b745ae3a4d10512861252603990390b01082616754e561f88d22b0241f2cf7e4`;
the public status observation has SHA-256
`3bb8f592c3dad676ed23c0d0adee1a4cc6ae2fbb39127733c01de3dc20ffb196`.
Maintenance followed this checkpoint. Its first capture attempt stopped at a
file-inventory check after services were stopped; a successful encrypted backup,
restart or admission resumption is not established here. Keep the active note
and its original custody. A prior HTTP200 is not a current health check.

</details>

<details>
<summary>Funding and access history (docs/sdk/devnet-funding.md)</summary>

## Access and real provider spending

Devnet faucet tokens do not purchase real provider credit. The preview operator
covers provider charges using the separately authorized acceptance budget;
ordinary consumers do not supply provider-management credentials or send mainnet
USDC to obtain faucet funds. The campaign accounts for provider exposure using
the reviewed one-USD-to-one-USDC assumption; faucet balances and the real
provider bill remain separate.

The [initialized grant](PD-detached-budget-initialization.md) allows
at most **seven new AUTH reservations of 1,000,000 micro-USDC each**, a total
seven-USDC maximum exposure, for the named B-01–B-03 and N-01–N-04 acceptance
cases. It selects direct OpenRouter Chat, `openai/gpt-4o-mini`, a 60-second session
TTL and at most 128 output tokens. This is a bounded, invitation-only campaign,
not an ongoing public spending allowance. Reservations are retained even when
the verified charge is smaller; no automatic retry or replacement grant is
authorized.

At the [N-01 checkpoint](PD-native-public-N01.md) on
2026-10-08 at 06:54 UTC, a five-USDC **Devnet** deposit had finalized and one
response had settled for 6 micro-USDC, leaving an active note balance of
4,999,994. The [07:43 operator join](PD-N01-operator-join.md)
independently matched its one full-cap reservation and signed settlement.
Admission was subsequently suspended at 07:58 UTC. These are dated observations,
not permission to fund or send a request now; consult the
[operator status and incident guide](../sdk/public-devnet-operations.md).

Request an invitation from the deployment operator through the repository
maintainer's private communication channel. There is no public invitation code.
An invitation does not reserve capacity, override suspended admission or authorize
an additional campaign. Keep it out of URLs, shared configuration and issue
reports. Browser connections hold it in memory; native installation uses an
owner-only file scoped to the exact AUTH endpoint.

The previous private campaign remains separate: its historical 17 reservations
total 9,154,216 of 10,000,000 micro-USDC, leaving 845,784. No original capacity
was transferred to the new grant, and reservations must never be reset or
reclaimed to retry a case. Installing a profile alone authorizes no spending.

</details>
