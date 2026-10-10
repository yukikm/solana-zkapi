# Public Devnet readiness backlog

For the 2026-10-10 disk-exhaustion repair, operator-funded admission policy and
fresh service checks, use the [current support status](sdk/status.md). Dated
grant limits and availability observations below retain their original scope.

Current core scope — 2026-10-09 JST: **finish ZKAPI core; stop demo/chat UI work**.
Funded browser/Phantom PD-08 is deferred, not completed and not a core gate.
The [scope reconciliation](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-core-scope-reconciliation.md) credits
same-host public-input `.3` installation, 385 local SDK checks and the recorded
native N-01–N-04/OpenClaw lifecycle and mutual closure.

The [Ethereum OpenRouter capture policy](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-ethereum-parity.md)
is installed. It captures management usage after disable/grace, persists it,
confirms deletion and retains capped immutable settlements. Delayed accounting
remains the operator's risk; the historical response-cost discrepancy stays
disclosed without a new invoice-finality gate or retroactive repricing.
[Warm restart](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-warm-restart-20261009.md) verified populated caches
and bounded reads. The [writer throughput successor](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-replay-writer-deployment-20261009.md)
is installed, with the follower and financial cut preserved.

[Public restoration](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-restoration-20261009.md) completed the
guarded gateway start after fresh finalized reconciliation. Separate public
HTTP 200 at 00:54:37 UTC reported all capabilities available and relay status
reported admission/recovery enabled; installed `.3` preflight passed ten checks
at 00:55:26 with all 7,257 files unchanged and no AUTH or wallet action.
The complete financial cut and four reservations were preserved. Earlier
failed starts remain recorded; this is not continuous-availability evidence.
[E01 escape/finalize](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-E01-emergency-withdrawal-20261009.md) subsequently
completed from the original deposit/journal: seven exact-wire finalized
transactions, one micro-USDC returned, Note closed and `Pending.exists=false`.
Its journal contains zero AUTH; the complete operator database and four
reservations remain unchanged. The [core completion record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-core-completion-20261009.md)
adds fresh public readiness and enabled relay admission/recovery at 01:43:23 UTC.
Final evidence and the updated handoff are linked and versioned in this documentation update. The [80 GiB data volume remains retained](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-capacity-retained-20261009.md),
with 30,190,022,656 bytes available at 00:25:35 UTC and retained archive data
already exceeding 40 GiB. Returning to 40 GiB requires a verified migration;
none occurred, and no new storage approval is claimed. No UI work, new paid
matrix, pristine-OS expansion or long-term qualification is added.
Dated observations below remain historical; their old pending statements do
not undo later receipts.

## Historical checkpoints

Readiness deployment checkpoint — 2026-10-08 15:16 UTC: [public capability reporting and explicit admission resume](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-readiness-deployment.md) completed. The first local HTTP503 (`indexer: unavailable`) remains preserved with cause unproven; separate read-only completion passed without a source change. Only control/gateway restarted, preserving the other four processes and the complete closed four-session financial cut. Provider credit and admission are not checked by the readiness endpoint; the separate relay configuration confirms admission enabled. Funded browser cases, E01, provider-cost reconciliation and planned 80 GiB expansion remain outside this checkpoint.

Native closure checkpoint — 2026-10-08 14:27 UTC: [N-04 interrupted-stream recovery and mutual withdrawal](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N04.md) are complete: one deliberate process-group kill, same-journal .3 restart, one explicit recovery, four independently verified signed settlements totaling **20 micro-USDC**, and return of **4,999,980 micro-USDC**. Six finalized exact-wire transactions establish the closed note and Vault zero; wallet equals treasury owner, so its restored balance does not erase charges. The final operator cut retains four full-cap reservations (4M micro-USDC exposure), four settled sessions and all 25 checkpoint rows. [OpenClaw text/read-tool continuation](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md) passed in its separate scope; [external provider-cost reconciliation](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-management-usage-limit.md) remains unresolved. [SDK .3 source CI](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-hosted-ci-e2ee932.md) passed all nine implementation jobs at exact source `e2ee9320…`, separate from live acceptance. Subsequent [independent backup verification](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-backup-independent-verify.md) completed exact-version download, streamed archive checks and isolated PG16 logical restoration of the original one-session N01 cut; it does not restore the later four-session state or physical services. Funded browser cases, the separate zero-AUTH emergency exercise and deployed aggregate readiness remain unfinished. Preserve the interrupted response, all failed preparations/observations, immutable releases and original journals; no inference replay or chat-history restoration is implied.

OpenClaw failure checkpoint — 2026-10-08 12:04:14 UTC: the first actual request returned HTTP 400; no read-tool continuation or second forwarded request completed. The [failure record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openclaw-first-request-failure.md) preserves the original launch/forward fences, unchanged native journal revision 371 and the independently observed unchanged one-reservation N-01 operator cut. No new AUTH, reservation, session or charge is evidenced; network packet counts remain unknown. The surfaced `400 terminated` error and separate context warning do not yet establish the original cause. N-02/N-03 remain unverified, with no acceptance checkbox changed.

Resume checkpoint — 2026-10-08 11:45 UTC: **admission resume completed**, followed by public HTTP 200 reporting admission and recovery enabled. The [service-recovery record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-service-recovery.md) joins the successful run06 to fresh installed-native preflight and two unchanged full local readiness checks; public `/relay-status` remains configuration-only. The pre-resume financial cut retained one N-01 full-cap reservation, the verified six-micro-USDC charge and active signed balance of 4,999,994 micro-USDC. Earlier attempts01–05 and all capture/restart/decoder failures remain preserved. This is a dated checkpoint, not a current balance or continuous-availability claim. Root launched N-02/N-03 around 11:48 UTC; their outcomes and any later reservations or charges are not included here. N-04, funded browser acceptance, withdrawal and independent backup restoration remain unverified. The readiness control candidate is still undeployed.

Historical handoff — 2026-10-08 10:55 UTC: the [writer application-log correction](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-rpc-program-log.md) is installed as binary `23bbb73f…83b372`; its start receipt records cold validation/replay in progress. **Fresh readiness and admission resume remain unverified; admission is false.** N-01 still has one full-cap reservation, a verified six-micro-USDC charge and an active signed balance of 4,999,994 micro-USDC. No additional paid case, funded browser case or withdrawal is claimed. [CI at `27ef2a4`](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-hosted-ci-27ef2.md) passed all nine jobs; the latest root-saved successor `e36cfbcd…` cut had eight successful jobs and client/challenger pending. The dated text and checklist below remain unchanged historical records.

Original handoff: 2026-10-07 JST. Status checkpoint: 2026-10-08 09:40:40 UTC.
**Public inputs and earlier read-only browser/native preflight are verified.
Native N-01 completed its deposit, Chat response and signed settlement; encrypted
capture and same-state service restart also completed. Cold replay later ended,
but the writer now pauses on archive-decoding errors at the next finalized block.
Fresh readiness and admission resume are blocked; new admission is false.
Withdrawal and the remaining live cases are unfinished.** The original document below records the
separate-session request after an independent chat application could install
the SDK but could not complete a public-input-only integration. Subsequent
deployment and verification evidence is linked here; historical checkpoints
retain their original scope.

Implementation follow-up: [design and implementation record](public-devnet-implementation.md).
That follow-up adds profile/preflight/onboarding and transport/release guards.
The [current public inputs](sdk/public-devnet-preview.md),
[asset publication and proof checks](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-assets.md), and
[English app publication](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-zkchat-english-publication.md) now establish
their separately recorded scopes. Completed distribution, profile, preflight and
policy checks are marked below with their evidence. Local fixtures do not close
the separately required funded lifecycle acceptance.

Historical follow-up: [independent app, complete proof bundle and deployment preparation](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-devnet-followup.md).
The four-file redistribution question is resolved. AWS-generated HTTPS is
selected and seven additional USDC of provider exposure are approved. The user
approved proceeding with the roughly USD50/month
[US East configuration](../deploy/public-devnet/aws-budget-host.md) on 2026-10-08 JST.
This supersedes the previous seven-day/USD100 proposal. The user excluded
long-term qualification from the current scope; current deployment headroom and
live lifecycle acceptance still require verification. The actual `zkchat` app
is updated and published. Earlier public preflight and unfunded browser/native
initialization passed in their recorded scopes. The
[earlier RPC checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-rpc-quota-blocker.md) preserves the
previous endpoint's monthly quota and the official free fallback's HTTP 429.
The supplied Helius Devnet RPC is now configured. The
[migration/storage checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-rpc-migration-startup.md) records
four transport-field changes with original history and financial identities
preserved. The [decoder correction](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-rpc-log-truncation.md) passed
the previously stalled block: at 03:15:49 UTC the writer had appended 9,178
blocks since that stop. Root/snapshot still returned HTTP 503, control/gateway
were inactive and admission remained suspended. Funded browser/native/provider
and recovery acceptance remain unfinished. The same-volume 20-to-40-GiB data
expansion changes the fixed 730-hour hosting illustration to USD39.969,
excluding variable charges and actual taxes; it does not establish long-term
capacity. No new AI-provider inference or budget reservation occurred.
The [detached authority checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-detached-budget-initialization.md)
records the approved seven-cap grant initialized with zero reservations, without
transferring or reclaiming the original ledger's capacity.

The [runtime and independent-origin checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-runtime-origin-followup.md)
records later six-service readiness, public/local response agreement, actual
cross-origin Chrome preflight and worker execution, and installed-native
preflight through 05:32:43 UTC. It supersedes the earlier 503 observations for
that read-only checkpoint. The [admission recovery checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-admission-recovery.md)
records the subsequent failed policy check, preserved original operation and
successful explicit continuation at 06:20 UTC. Admission and recovery were
publicly observed enabled with zero reservations. The first native deposit
preparation then failed before a saved wallet operation or funding; a public
wallet read route returned HTTP 400. The separately recorded
[wallet-route correction](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-wallet-route-fix.md) then passed
installed-SDK snapshot checks through the unchanged stock native transport.
The [native N-01 checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N01.md), through
06:54:45 UTC, records a finalized five-USDC Devnet deposit, one real Chat
response and a cryptographically verified six-micro-USDC charge. The note
remains active with a signed balance of 4,999,994 micro-USDC. Service recovery,
OpenClaw, interrupted-session recovery, withdrawal and funded browser acceptance
remain unfinished.

The [operator authority and settlement join](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-operator-join.md),
at 07:43:48 UTC, subsequently matched N-01's exact pending AUTH digest,
SDK-verified successor signature and six-micro-USDC charge to the existing
one-cap reservation and selected operator settlement. Its read-only collector
classified seven retained terminal checkpoint rows with zero unresolved work;
it did not remove rows or change financial state. The following local draft
assembly failed its certificate-phase check. That failed attempt remains
preserved, the cut was not approved, and no admission suspension, backup or
restart success follows from this join.

Dated follow-up — 09:22 UTC: the [service-recovery checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-service-recovery.md)
records the successful capture continuation and guarded same-state restart,
preserving the first failed capture and all 13 stopped-prefix records. The
09:01 observation found all six services active, zero automatic restarts and
the original follower unchanged; fresh writer readiness and admission resume
remain pending. The note remains active at a signed 4,999,994 micro-USDC after
one reservation and a six-micro-USDC charge. No N-02–N-04, funded browser case,
withdrawal or backup restore follows from these receipts.

The 24-path source follow-up is public at
[`27ef2a4c842927240e0fae776a5017a46b6c141d`](https://github.com/yukikm/solana-zkapi/commit/27ef2a4c842927240e0fae776a5017a46b6c141d).
Its [readiness candidate](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-readiness-candidate.md) has a built
Linux control binary (`505b7e65…20c36a7`) but is not deployed. The
[OpenClaw scheduling adapter](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openclaw-settlement-adapter.md) has
local fixture evidence only. [Hosted CI at `1a25289`](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-hosted-ci-1a252.md)
passed all nine jobs; successor [run 37755041914](https://github.com/yukikm/solana-zkapi/actions/runs/37755041914)
at the new source was in progress with four of nine jobs successful at 09:21 UTC.
No new whole-workflow pass is claimed. All existing checklist boxes remain
unchanged, as do the original 17-row ledger, client releases, initial anchors
and private credentials/custody.

Dated follow-up — 09:40:40 UTC: the [recovery evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-service-recovery.md)
records a new post-replay blocker, separate from the successful capture/restart.
Fresh non-ready writer health and repeated `RPC archive encoding` messages stop
progress at durable tail `508763135`; the next-slot response is retained for
source/fixture diagnosis. The frozen old native decoder isolates application
`Program log: ` text containing ` failed:` as misclassified runtime completion.
A narrow correction is under local verification; no deployed fix is claimed. Pending jobs and unknown signatures are zero; the settled N-01 note
and one-cap reservation remain unchanged. No additional paid case, browser
funding or withdrawal has run. The root-saved successor CI cut around 10:05
had eight jobs successful and client/challenger in progress; it is not a new
whole-workflow pass. Existing checklist boxes and earlier dated checkpoints
remain unchanged.

Dated follow-up — 10:55 UTC: the [application-log correction and deployment record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-rpc-program-log.md) supersedes the earlier “under local verification” status for the writer fix. The exact installed binary is `23bbb73fe88fcb111a1ca090cabe9cb0233693e09c9e2fc0d70b790f3b83b372`; only the writer was stopped, replaced and started. Its old executable, archive, configuration, five other processes and complete financial rows were retained. The stop had unavailable native exit metadata; the new start receipt records cold validation/replay, not fresh readiness. Admission remains false, with N-01's one reservation, six-micro-USDC charge and active funds unchanged. No resume, additional inference, withdrawal or full lifecycle follows from this deployment. [Hosted CI at exact source `27ef2a4`](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-hosted-ci-27ef2.md) finished all nine jobs successfully. The latest root-saved `e36cfbcd…` cut remained eight successful jobs plus client/challenger pending. Readiness candidate `505b7e65…` is still undeployed; checklist acceptance is unchanged.

## Objective and scope

An independent application maintainer should be able to start from public
documentation and immutable release assets, select a supported Devnet deployment,
and complete funding -> real chat -> verified settlement -> recovery -> withdrawal
without access to the operator's checkout, private configuration or signing keys.
Application users should choose a wallet and fund it; they should not assemble
cryptographic deployment pins.

Conversation history storage, display and inclusion in later requests belong to
the consuming application. Multi-turn acceptance checks that ZKAPI accepts the
application's next explicit request after settlement; it does not add a chat
history feature to ZKAPI. Recovery in this backlog concerns financial operations,
signed settlement and operator chain-monitoring state after interruption. It must
not replay inference or claim to restore the application's conversation history.

Deliver a usable, explicitly scoped **public Devnet preview** first. This backlog
extends the external-integration work under I10 and the relevant distribution
work under I11; it does not replace the existing
[implementation plan](implementation-plan.md), accept G1-G4, or authorize I12
mainnet deployment. Reuse the existing SDK, services, prover, trust validation
and financial state machine. A new protocol implementation is not the goal.

At the original documentation-only handoff, the user intended design and
implementation to continue in another session. That handoff changed no services,
deployments, funded profiles, manifests, circuits, credentials, budgets or runtime
code. The subsequent implementation and deployment records above are separate.

## Original baseline and evidence

| Item | Baseline / observed boundary |
|---|---|
| Reviewed local source | `eb9a5d1e384cee97a545e7482c0f3c223da0b2ac`; working branch `work` |
| Public SDK | `v0.2.0-devnet.1`, source `088ca40bf5886738f87b4db97205db8bff752356`, Solana Kit 8.4.0 |
| SDK tarball SHA-256 | `e6ff141b1c13c278f1c6d80dbe1397f187290270c583a32545df5fe4fbd45019` |
| Published assets | Compiled SDK, macOS ARM64 clientd, release manifest and checksums; publication/attestation evidence already exists |
| Explicit release exclusions | Default public operator, complete proving bundle and new Kit funded-provider acceptance |
| Independent consumer observation | The separate `zkchat` app installed this SDK and built its integration, but had no configured public deployment bundle/operator; its UI and adapter tests did not perform real proof generation, funding or inference |
| Existing upstream live evidence | Selected Devnet deployments, deposits, direct/proxy OpenRouter use, signed settlements, mutual withdrawal and escape/challenge have already succeeded in separately scoped historical cases |
| Remaining distinction | Historical success with configured operator profiles/custom relays does not provide a currently available, documented default operator or establish live acceptance of the published Kit package |

Sources: [Kit release scope](releases/kit-preview.md),
[publication evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-kit-publication.json),
[SDK status](sdk/status.md),
[external integration evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-external-integration.md),
[direct-provider parity evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-parity-review.md),
[deployment inputs](sdk/deployment.md), and
[distribution contract](../packages/sdk/DISTRIBUTION.md).
The independent app's report is `zkchat/docs/INTEGRATION-REPORT.md` in its separate
workspace; this backlog repeats its relevant observation so that workspace is
not required to understand the tasks.

**Do not describe this gap as "Solana Devnet cannot be used" or "no real provider
test exists."** The missing outcome is an externally consumable deployment and
a reproducible lifecycle through its published client path. Existing code,
packaging helpers and successful historical tests must be reused and credited.

## Ethereum comparison: what the public product supplies

At Ethereum source
[`045b444ea1b52538d1b40273c7cb6ed09468a052`](https://github.com/ethereum/zkapi/tree/045b444ea1b52538d1b40273c7cb6ed09468a052),
the [browser SDK documentation](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/sdk/README.md)
describes packaged Mainnet/Sepolia profiles, Vault and signing-key pins, WASM,
proving keys, and a build helper. The
[local daemon](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/zkapi-clientd/README.md)
provides an OpenAI-compatible API without an end-user OpenRouter management key.

Read-only requests in the preceding comparison obtained both public
configuration files and healthy responses from
[Mainnet](https://zkapi-mainnet.openanonymity.ai/health) and
[Sepolia](https://zkapi-sepolia.openanonymity.ai/health).
Sepolia reported `testnet_password_required: true`; Mainnet reported false.
This was endpoint/configuration verification, not paid Ethereum inference or
withdrawal acceptance. These URLs are comparison evidence, not Solana endpoints.

Ethereum's release-pinned configuration and signing public keys are not the
same thing as a separately signed configuration file. Solana already has its
own signed manifest plus independent `ManifestTrustPolicy`; retain that trust
contract. Native ETH billing, Ethereum oracle configuration, unrestricted
testnet access and an npm registry release are not prerequisites for parity
with the independent-consumer experience.

## Priority and dependency map

P0 tasks below apply to the current core preview scope. The original funded
browser requirement is now deferred by the user.
P1 work improves the broader product or production release and must not be
quietly claimed by completing P0.

| ID | Priority | Deliverable | Depends on |
|---|---|---|---|
| PD-01 | P0 | Public operator and canonical Devnet deployment | Deployment/ownership decision; aligned with PD-02/03 |
| PD-02 | P0 | Complete distributable proof and WASM assets | Redistribution decision and selected setup |
| PD-03 | P0 | Authenticated, versioned public deployment profile | PD-01/02 identities and artifacts |
| PD-04 | P0 | Browser-safe transport and read-only diagnostics | PD-01/03 |
| PD-05 | P0 | Live provider, model and tariff configuration | PD-01; operator provider access |
| PD-06 | P0 | Devnet funding, access and provider-spend policy | PD-01/05 |
| PD-07 | P0 | Public-input-only SDK and clientd onboarding | PD-02/03/04/05/06 |
| PD-08 | Deferred | Independent browser lifecycle on released Kit SDK | Separate app work; not a current core gate |
| PD-09 | P0 for native scope | Released native client lifecycle through supported transport | PD-01 through PD-07 |
| PD-10 | P0 | Published evidence, service recovery and release handoff | Current core evidence and PD-09; PD-08 deferred |
| PD-11 | P1 | Additional clients/platforms and production gates | Scoped follow-up after P0 |

PD-09 applies to the selected native core path. Checked items below cite their
completed evidence. Unchecked items retain their stated coverage boundaries;
PD-08 and broader platform/OS coverage are explicitly outside the current scope.
The original requirements called for an owner, chosen deployment, exact release
versions and measurable scope before implementation. Current choices are
recorded in the linked deployment evidence, not inferred from this baseline.

## PD-01 — Publish and operate a canonical Devnet deployment

**Gap:** services and Devnet programs exist, but the release does not select or
offer a default public operator. A historical program address, local relay or
localhost service is not a complete public integration.

Work:

- Select an existing compatible deployment or provision a new one. Record why
  its program/build, Pool and setup can be used together; do not mutate an
  existing funded profile to turn it into the public default.
- Publish deployment ID, cluster/genesis, program ID, Pool, mint/token program,
  decimals, Vault/treasury derivation or addresses, build identity, setup
  assumptions and actual admin/upgrade authorities.
- Provision stable HTTPS routes for control, indexer, artifacts and any enabled
  inference path. Run the required signer, database, provider dispatch and
  challenger components with persistent state and an identified operator.
- Define service ownership, availability window, maintenance/retirement policy
  and public redacted health/readiness output. Health must distinguish a live
  HTTP process from usable chain/indexer/provider state.
- Include deployment receipts and a finalized comparison of actual program
  bytes/upgrade authority/Pool configuration to the selected pins.

Acceptance:

- [x] An independent installation on the supported macOS ARM64 host obtains
  public addresses and reaches the documented routes without a developer tunnel,
  source checkout or private CA. A pristine-OS run is outside this preview scope.
- [x] Read-only validation binds the selected cluster and finalized Pool to the
  release's reviewed program/build/setup identity.
- [x] A stale indexer, unavailable signer or disabled provider is reported as a
  specific unavailable capability; no fabricated healthy state is returned.

Binding evidence: [actual independent Chrome and installed-native preflight](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-runtime-origin-followup.md)
passed all ten checks against the authenticated profile, manifest and complete
artifact bundle, including genesis, finalized Pool owner/PDA/configuration,
circuit-profile binding and shared snapshot/chain clock. The
[immutable release and independently published profile pin](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-client-publication.md)
and [matching downloaded native/WASM proof checks](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-assets.md)
retain the reviewed artifact identities. The [isolated public-input `.3` installation/setup](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-core-scope-reconciliation.md)
and native N-01–N-04 cover the recorded consumer routes. This is same-host
installation isolation, not a pristine operating system or live injection of
every signer/provider/indexer failure. The later
[deployed readiness record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-readiness-deployment.md) and
[targeted production readiness fixtures](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-readiness-candidate.md)
now cover specific capability reporting in their stated scopes. No new live
fault matrix or provider-disable feature is required by this scope reconciliation.

Reuse: [control service](../services/control/README.md),
[indexer](../services/indexer/README.md),
[challenger](../services/challenger/README.md),
[operations](../deploy/operations/README.md) and existing public-profile scripts.

## PD-02 — Resolve and publish the complete proof asset bundle

**Original gap:** the SDK package intentionally contains no deployment, WASM or proving
keys. The prepared complete bundle was omitted because redistribution terms for
four upstream setup PK/VK files were not established. That was an unresolved
release decision in the original handoff, not a finding that redistribution is
legally prohibited. **Follow-up:** the pinned original-author README establishes
MIT OR Apache-2.0; the Apache-2.0 branch is selected for those exact four files,
with authenticated notices. See the [corrected review](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-02-redistribution-followup.md).
The separately completed public-download acceptance is recorded below.

Work:

- Record authoritative provenance/terms and a reviewed distribution decision for
  each omitted file; preserve required notices. Do not silently copy those
  files into a public release while this decision remains unresolved.
- If the resolution requires another setup, plan a compatible new program/Pool
  and versioned client profile. New keys must never replace the pinned verifier
  of an existing note or be treated as an asset-only refresh.
- Package signed manifest, trust policy, compiler-backed IDL, request and
  withdrawal PK/VK, tree PK/VK, tree source bundle, verifier constants, all
  additional artifacts and the exact WASM with its hash.
- Publish immutable versioned files, sizes, SHA-256 values, source/build
  provenance and setup limitations. Keep the native prover distribution pinned
  for native consumers as well.
- Reuse the existing offline packager and `loadDeploymentAssets`; do not
  introduce another artifact format unless a versioned design requires it.

Acceptance:

- [x] Every dependency is retrievable from the documented public release/static
  host and usable without operator-private paths or files.
- [x] An independent installed SDK verifies the descriptor and all artifacts,
  produces real proofs with the matching WASM/native prover, and rejects a
  missing/modified/mixed-deployment artifact.
- [x] A release test checks actual downloadable bytes, not just a local bundle
  or an artifact name listed in documentation.

Completion evidence (2026-10-08 JST): [27 anonymous profile/bundle downloads](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-assets-download.json)
matched the reviewed bytes, followed by [six fresh installed native/WASM proofs](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-assets-proofs.json),
six independent supplied-VK verifications and 18 proof-level negative checks.
WASM ran under Node; this is not browser proof or funded acceptance. The same
SDK archive `fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc`
also passed the separate [75 installed-package fixtures](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-devnet-followup-components/external-results.json).

A further offline check used the actual downloaded descriptor
`10a85725034a18bfa3e07913af9cdf89bd10ca05c4ce50aefe5f766a2431c9c8`
and independently installed SDK tree
`18a6a7579c9c1191aa0f864edb52ad6d323e751d35b68f4cbe786bef79695f08`:
the baseline loaded, while a missing request PK, one-byte-modified request PK,
and tree VK substituted from the older local deployment each failed closed.
The substituted VK was `4e62f971f0467a8cd1733194425904d9433cc59f2badaf2e12cc3fda87285443`
instead of `d087ca522e5dc84b0c23daf2e5ebefcca0b489c5aaaf850bd18373a397cb387c`.
No source bytes changed and no network or financial action occurred. The retained
`downloaded-bundle-loader-rejections.json` report SHA-256 is
`1b210b064c8417c7fed562d82f2185993458efa8674a6cbc7898d9dfd5065d13`.

Both [documented public client archives](sdk/public-devnet-preview.md) also
returned anonymous HTTP 200 with validated TLS and immutable cache headers:
the SDK above was 121,467 bytes; the 71,056,092-byte macOS ARM64 native archive
matched `9a2ab6759d99b3d7031b4c939ab654caeec2244763d1f16538e471bd5675cb56`.
The retained anonymous client-download report SHA-256 is
`7e8471ea3444c2fc1dc5e19b16432949e233ce5d7b029a2b8beee8c26122d2ec`.
These complete PD-02 distribution checks, not PD-08/09 live lifecycle or a new
GitHub release-attestation claim; the immutable `.1` releases remain preserved.

The subsequent [immutable `.2` GitHub publication](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-client-publication.md)
now establishes release/asset attestations and fresh anonymous downloads of the
same client bytes. It does not change the scope of the earlier static-host checks
or establish funded lifecycle acceptance.

Reuse: [distribution format](../packages/sdk/DISTRIBUTION.md),
[omission explanation](releases/devnet-preview.md),
[third-party notices](../THIRD_PARTY_NOTICES.md),
[packager](../scripts/package_sdk_distribution_assets.mjs).

## PD-03 — Distribute a complete authenticated deployment profile

**Gap:** validation types and loaders exist; the independent maintainer still
has to source and assemble the deployment inputs separately.

Work:

- Define a supported, versioned public profile combining the bundle URL and
  independently distributed descriptor hash, reviewed trust/build pins, RPC and
  indexer origins, model/tariff allowlist, explicit direct/proxy mode, and the
  provider/verifier bases required for the selected direct mode.
- Enumerate the existing manifest's deployment/genesis/program/Pool/mint,
  signing keys, circuit/setup/IDL/artifact identities, capabilities, cap, note
  TTL, challenge period and service origins. Reuse the exact SDK contract rather
  than inventing a second list of financial truths.
- Distribute the initial trust anchor through a reviewed release or equivalent
  independently authenticated channel. A hash or public key fetched solely
  from the same untrusted endpoint must not authenticate that endpoint.
- Define SDK/protocol/profile compatibility, rotation, revocation, rollback and
  retirement behavior. Funded or unresolved journals retain their original
  deployment identity and recovery route.
- Derive browser and native configuration from the same reviewed public inputs;
  document consumer-local file paths and credentials separately.

Acceptance:

- [x] A maintainer installs one reviewed profile without manually copying
  cryptographic constants from historical evidence or an operator's filesystem.
- [x] Wrong genesis/program/Pool/mint, swapped signing keys, tariff mismatch,
  altered WASM and unsupported capabilities fail before financial mutation.
- [x] Updating the SDK/profile cannot silently rebind funded or uncertain state.

Evidence: [public native and browser unfunded initialization](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-consumer-unfunded-startup.md)
used one pinned profile and public assets. The
[immutable client release](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-client-publication.md) publishes the
profile pin independently from the artifact host. Its exact-source
[377 SDK / 75 installed-package hosted checks](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-client-hosted-ci.md)
cover trust mismatches, retained installation identity, immutable authenticated
configuration and existing custody/recovery guards. Negative and upgrade guards
are fixture evidence; these checks do not establish a funded public lifecycle.

Reuse: [deployment contract](sdk/deployment.md),
[trust types and checks](../packages/sdk/src/trust.ts),
[asset loader](../packages/sdk/src/deployment.ts).

## PD-04 — Make browser transport and preflight usable externally

**Gap:** the bounded relay and browser factory exist, but a public host's
CORS/routes/RPC configuration and actual external-browser acceptance are not
provided by merely publishing the library.

Work:

- Specify supported direct CORS and/or same-origin relay deployment. Publish
  exact allowed origins, methods and routes, CSP/worker requirements and a
  tested host configuration.
- Include both shared tree snapshot routes, RPC, control, settlement/recovery
  and the selected inference/provider paths. Use public-safe RPC or a bounded
  relay; never embed credential-bearing RPC URLs or provider management keys.
- Preserve credential omission, redirect refusal, abort propagation, bounded
  reads, exact request bodies and the no-automatic-inference-retry policy.
  A generic arbitrary-destination proxy is not an acceptable shortcut.
- Add/reuse a documented read-only preflight that checks asset hashes, manifest,
  genesis, finalized Pool, snapshot compatibility/freshness, reachable routes
  and configured model capability, with useful redacted errors.
- Explain browser storage/worker requirements and how to retain the same origin
  and custody namespace. Do not evade browser security blocks.

Acceptance:

- [x] A separately hosted app on its own origin passes preflight in a supported
  real browser and runs the published worker/WASM.
- [x] Preflight/status performs no deposit, AUTH, paid inference, custody reset or
  silent prompt to sign; any user permission requirement is documented.
- [x] Public assets, diagnostics and network traces contain no operator secrets;
  failure identifies the failing component instead of saying only "disconnected."

Evidence: [independent-origin Chrome preflight and worker](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-runtime-origin-followup.md),
[actual public unfunded startup](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-consumer-unfunded-startup.md),
[public app and redacted diagnostics](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-zkchat-english-publication.md),
[anonymous assets](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-assets.md), and the exact released client's
[preflight/redaction fixture checks](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-client-hosted-ci.md).
Explicit new-storage creation was a separate action after preflight. These checks
do not establish browser proof generation, provider CORS or a funded lifecycle.

Reuse: [browser relay](../scripts/devnet-browser-relay/README.md),
[hosting requirements](sdk/deployment.md), existing SDK browser/transport modules.

## PD-05 — Offer an actually usable provider/model/tariff combination

**Gap:** adapters and selected historical provider successes exist, but a
third-party app has no published default operator model/tariff configuration and
cannot obtain a usable service from a model name alone.

Work:

- Choose and operate at least one explicitly supported text Chat path for the
  first public preview. Keep the broader required direct/proxy and provider
  scope in I10; do not label a one-path preview as full parity.
- Provision the operator's actual management/issuer/provider access and credit.
  For direct modes, configure the independent provider bases and OA verifier
  where applicable; do not assume ordinary inference keys grant issuance rights.
- Publish model IDs, API, mode, streaming/tool support, restrictions, fixed
  integer tariff data/hash/version, authorization cap and billing semantics.
  Backend quote/receipt configuration must match the published profile.
- Exercise real key issuance or proxy dispatch, response consumption, usage
  collection, signed settlement and cleanup. Unsupported or unavailable models
  must fail clearly without silently changing provider or privacy mode.
- Distinguish "implemented", "locally tested" and "live verified" per combination.

Acceptance:

- [x] The advertised Chat model returns actual provider output and a
  SDK-verified signed successor/charge through the public deployment.
- [x] Streaming is live-tested if advertised; terminal usage/empty choices,
  cancellation and settlement state are handled.
- [x] Pricing/cap changes cannot alter an already accepted operation; no
  provider-management secret is requested from an ordinary hosted-service user.

The [native N-01 checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N01.md) establishes the
first item for direct OpenRouter `openai/gpt-4o-mini` nonstreaming Chat on the
immutable `.2` native client. Later [N-02/N-03](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md)
completed streamed OpenClaw text/read-tool continuation on `.3` through the
explicit local scheduling adapter; [N-04](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N04.md)
completed interrupted-stream recovery and withdrawal. These are scoped live
results, not every streaming/error combination. N-02/N-03's signed zero amounts
remain valid for the observed management counters, while
the [response-cost discrepancy](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-management-usage-limit.md)
remains disclosed under the selected [captured-usage parity policy](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-ethereum-parity.md).
No invoice-finality claim follows. The streaming item combines these actual
streamed/interrupted cases with the released [SDK’s 385 passing local guards](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-core-scope-reconciliation.md), including
empty terminal-usage choices and cancellation. Quote tests verify Ed25519, exact
cap/tariff binding and retained price snapshots; native consumers used only
their local credential and invitation, never operator management credentials.
These checked behaviors do not claim every provider/API combination.

Reuse: [model contract](sdk/deployment.md),
[provider acceptance](provider-acceptance.md),
[SDK SSE correction](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-sdk-sse-parser.md).

## PD-06 — Define funding, access and the cost of public testing

**Gap:** Devnet SOL/test USDC do not pay the operator's real provider bill.
Funding must match the selected mint, and the public preview needs an explicit
access and spending policy.

Work:

- Document the Circle Devnet USDC mint and token program accepted by the current
  release, how a new user obtains that USDC, and how to obtain SOL for fees/rent.
  The current [chain validator](../services/control/src/chain.rs) enforces mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` and SPL Token program
  `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. An alternative test mint needs
  a separately scoped design and acceptance; it is not an interchangeable
  funding option for this release.
- Check mint, decimals and recipient before funding; give a complete funding
  example with cap headroom and separate SOL fees. Do not imply arbitrary tokens
  named USDC or a mainnet transfer can fund the Devnet note.
- Decide who subsidizes real inference, the provider budget/caps, availability
  limits, rate limits and any invitation/password process. If access is gated,
  document how a third-party tester obtains it.
- Make exhausted subsidy/provider credit distinguishable from low note balance.
  Reject new work safely while keeping applicable settlement/recovery/withdrawal
  paths available.
- Preserve the historical campaign's immutable reservations. The latest handoff
  records 17 reservations, 9,154,216 micro-USDC reserved and 845,784 remaining;
  this cannot admit another full one-USDC authorization. Re-check the
  authoritative ledger in the implementation session; do not reset history or
  infer a new paid testing budget from this documentation request.

Acceptance:

- [x] A new tester can fund the right assets and understand all prerequisites
  from public instructions, including any access gate.
- [x] The operator has an explicit accountable provider-spend policy; a test
  token balance is never represented as real provider credit.
- [x] Funding/access/budget errors do not strand a note or trigger a replay.

The [funding guide](sdk/devnet-funding.md),
[detached authority policy](../deploy/public-devnet/detached-budget.md), and
[actual authority initialization](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-detached-budget-initialization.md)
separate test tokens, actual provider charges and seven nonreclaimable exposure
reservations. The [later admission checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-admission-recovery.md)
records enabled admission, and [N-01](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N01.md) records
the first metered use. The [final native cut](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N04.md)
retains four nonreclaimable caps, 20 micro-USDC of signed charges and a closed
note after return of 4,999,980 test micro-USDC. That does not close every
funding/access/budget failure path. The funding guide gives the exact mint,
Devnet faucets, SOL/rent, cap headroom and private invitation procedure, supported
by actual native deposits. [E01 recovery](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-E01-emergency-withdrawal-20261009.md)
continued the original deposit and saved journal after the RPC/indexer outage,
then completed escape/finalize and returned its one micro-USDC. Its zero-AUTH
journal and unchanged complete operator cut join the native recovery evidence
to close this scoped error/recovery item; this does not claim live injection of
every failure branch. Existing state remains preserved; no new failure matrix
is required. The
[provider-cost discrepancy](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-management-usage-limit.md)
remains disclosed under the selected operator-risk policy.

## PD-07 — Provide public-input-only SDK and native quickstarts

**Gap:** package installation works today; integration still requires
maintainer-supplied deployment/runtime/network inputs.

Work:

- Add a small independent browser example consuming only published package
  exports and the reviewed public profile. Include worker/asset build steps,
  wallet selection, funding, Chat/SSE, settlement status, recovery and withdrawal.
- Offer a reviewed helper/template for profile installation and asset placement
  if needed; retain explicit configuration of spending and wallet actions.
  Avoid coupling the core SDK back to the separate reference UI repository.
- Supply a native profile template or generator for public deployment inputs,
  deriving local paths/pins after installation. Keep local inference and
  management tokens separate from operator secrets and wallet custody.
- Document supported versions, platforms, health/diagnostic commands, common
  failures, upgrade/backup constraints and exact supported client configurations.
- Keep the separation between public-service consumption and self-hosting.
  The latter still requires an operator's credentials/infrastructure.

Acceptance:

- [x] In a fresh installation outside the checkout on supported macOS ARM64,
  the documented steps use downloaded releases and user-owned state; no
  source-relative import, unpublished runtime input, operator profile or reference
  app is required. Pristine-OS and other-platform coverage are deferred.
- [x] The browser example and native onboarding use the existing SDK lifecycle,
  preserve durable state, and disable automatic inference retries/fallbacks.
- [x] An actual user can reach a configured ready state without inventing URLs,
  hashes, tariffs or native absolute paths.
- [x] npm registry publication is not treated as a blocker: authenticated
  immutable tarballs remain a valid distribution channel.

The [verified immutable `.3` SDK/native release and revision-2 profile](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-sdk3-publication.md)
and [independent `.3` browser app](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-browser-sdk3-publication.md) are
the current public distribution. The [original `.2` publication](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-client-publication.md)
and its funded custody/profile remain preserved; no automatic migration follows.
Recorded service-ready onboarding is additionally supported by the
[actual downloaded-native setup and explicit unfunded browser initialization](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-consumer-unfunded-startup.md)
and [later independent browser/installed-native ten-check preflight](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-runtime-origin-followup.md).
Native inputs were derived by the installed public-profile helper; the browser
used the configured authenticated profile. These are actual configured-state
observations on the recorded environments, not a fresh-machine acceptance run.

Shared lifecycle, durable identity and no-retry behavior are covered by the
[independent application integration](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-zkchat-integration.md) and
the exact released client's [hosted SDK, external-package and Go guard checks](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-client-hosted-ci.md).
Those continuity/recovery guards are fixture evidence. The separately scoped
[native N-01](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N01.md),
[OpenClaw N-02/N-03](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md) and
[N-04](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N04.md) now establish the recorded native
lifecycle, including interrupted recovery and finalized withdrawal. They do not
establish a pristine-OS run or funded browser lifecycle. The later
[isolated `.3` public-input installation and setup](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-core-scope-reconciliation.md)
passed outside the checkout with empty consumer HOME/TMPDIR and only shipped
runtime tools. The tested scope is same-host installed-artifact acceptance. Pristine-OS and
other-platform coverage remain unverified outside the advertised macOS preview
checks; the broader original clean-machine follow-up remains uncompleted and is
not a core-preview gate. Funded browser acceptance is deferred.

Reuse: [SDK quickstart](sdk/quickstart.md),
[native quickstart](sdk/clientd-quickstart.md),
[clientd runtime](../apps/clientd/README.md).

## PD-08 — Verify the released Kit SDK in an independent browser app

**Deferred by the user on 2026-10-09 JST.** Demo/chat UI work and funded Phantom
cases are not current ZKAPI core completion gates. The original work and unchecked
acceptance items below are retained; no custody reset, transaction retry, new
funding or app publication follows from this scope change.

**Gap:** the independent zkchat UI/adapter tests are not live acceptance;
historical browser/native cases do not revalidate the newly published Kit client
or the proposed public deployment.

Work and required evidence:

- Install the exact released SDK and public profile in a fresh external app.
  Use a real Wallet Standard wallet (the existing acceptance choice is Phantom),
  actual WASM proofs and the public Devnet/operator/provider endpoints.
- Complete one note's deposit, at least two intentional conversation turns with
  context, real streaming if advertised, verified settlement and mutual
  withdrawal. Show provider output and charge independently of UI success.
- Exercise browser reload/close and explicit same-journal recovery after an
  interruption; record whether interruption happened before acceptance,
  during inference or after settlement. A clean settled restart is not
  unknown-send recovery.
- Check model switching only when multiple models are advertised. Check
  insufficient balance/access/provider failures before extra financial work.
- Record release/profile/artifact hashes, exact test scope and timing,
  finalized transaction signatures/slots/CU/bytes, verified receipts and the
  number of deliberate inference operations versus observed sends.
  Redact secrets and avoid publishing full private requests/journals.

Acceptance:

- [ ] The same note completes the real lifecycle and returns the expected
  remainder; SDK receipt accounting and finalized chain observations agree.
- [ ] No proof/provider/wallet adapter stub stands in for the claimed path.
- [ ] Recovery does not replay inference, silently create a new note, reset
  custody, or switch direct to proxy.
- [ ] Failure observations and untested cases are retained with the successful
  evidence; prior historical results are not relabeled as this run.

## PD-09 — Verify native integration through the shipped transport

**Recorded scope:** N-01 used the shipped `.2` public transport; the separately
pinned `.3` upgrade preserved its funded profile/custody for N-02–N-04. The native
note is now closed with four verified signed settlements. OpenClaw used an
explicit local scheduling adapter; immediate unmediated continuation and other
platforms/providers remain outside the verified scope.

Work:

- Use the immutable native release on its advertised platform with only the
  public profile, documented network configuration and local user custody.
- Run its supported supervisor/transport against public HTTPS endpoints without
  a hidden acceptance relay, hand-edited runtime or disabled TLS checks.
- Verify models/status, real text and tool continuation where advertised,
  streaming, signed settlement, restart/recovery and Devnet withdrawal.
- Start with the existing OpenClaw integration; record client version, request
  subset, UUID/retry policy and enabled model capabilities.

Acceptance:

- [x] The installed released client completes a real funded lifecycle through
  its advertised public transport and produces independently checkable receipts.
- [x] The external AI client receives only its local inference credential.
- [x] Recovery/unsupported-request behavior is verified in the production
  handler, not only a synthetic HTTP compatibility fixture.
- [x] The report names any remaining relay or platform limitation explicitly.

The [native N-01](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N01.md),
[OpenClaw text/read-tool continuation](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md), and
[interrupted recovery/final withdrawal](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N04.md)
records cover the completed path. Six finalized exact-wire transactions close
the five-USDC note and return 4,999,980 micro-USDC; signed charges total 20.
The actual OpenClaw configuration selects only the local inference-token file;
the scheduling adapter retains its separate local management credential, and
provider-management credentials remain operator-side. The reports distinguish
the adapter, macOS ARM64 and retained `.2` observer from the running `.3` client.
The recovery/unsupported-request item combines actual N-04 recovery with the
[existing production Go rejection and current SDK guard audit](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-core-scope-reconciliation.md).
The actual Claude Code unsupported-route probe reached the production handler;
its source pins still match the released Go handler. SDK API/metadata rejection
fixtures remain local tests, not paid acceptance. The first OpenClaw HTTP400's
cause is still unproven and is not used as rejection evidence. The
[external provider-cost discrepancy](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-management-usage-limit.md)
remains separate from signature and lifecycle completion.

Reuse: [OpenClaw integration](integrations/openclaw.md),
[external native evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-clientd-external.md),
[integration status](integrations/README.md).

## PD-10 — Publish the evidence and retain a recoverable service

**Selected core scope complete:** final evidence is linked and versioned in this documentation update. Published
inputs, native lifecycle, E01 emergency escape/finalize, installed OpenRouter
parity, warm restart, writer successor, public restoration and historical backup
restoration have scoped evidence. Funded browser acceptance is deferred. None
of the dated service observations is a continuous-availability guarantee.

Work:

- Publish the new profile/bundle with authenticated hashes and source/build
  versions; verify anonymous downloads and compatibility with the actual
  program/Pool before linking it as a supported default.
- Add focused public-distribution/preflight checks and retain their exact scope.
  Keep funded live tests deliberate and budgeted; do not put unattended paid
  inference into ordinary install, health or CI checks.
- Publish PD-09 evidence for the advertised native path; retain PD-08 as deferred,
  with a supported feature matrix and explicit
  unverified combinations. Preserve the known comprehensive-CI/evidence
  limitations until independently resolved; a focused pass is not "all CI".
- Exercise the existing operator recovery path on the chosen public deployment:
  indexer catch-up, same-ledger/signer-journal restart, service outage handling,
  challenger readiness and the supported escape/finalize path. A successful
  mutual withdrawal alone does not establish emergency withdrawal readiness.
- Define admission suspension, recovery/withdrawal availability, profile/key
  retirement and user-visible incident guidance. Never replace unresolved
  state with a fresh database, signer journal or manifest to restore green health.
- Make retained archive/replay memory and disk sustainable within the selected
  hosting allowance. The [capacity review](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-runtime-capacity-review.md)
  found full-block journal growth and a growing replay digest map. Preserve
  required evidence and existing journals; segmentation alone does not bound
  total disk use. Measure restart, catch-up, recovery and throttled CPU behavior
  on the selected Linux size before claiming continuous operation.
- Link the public operator, funding instructions, immutable profile, known
  limitations and evidence from README/SDK docs; remove placeholder-only
  onboarding from the advertised default path.

Acceptance:

- [x] A reviewer can reproduce the published setup and identify exactly which
  app/client/network/provider combinations were actually verified.
- [x] An operator restart/outage does not lose acknowledged reservations or
  authorize duplicate inference/settlement; applicable recovery remains usable.
- [x] Current preview memory/disk headroom and restart/recovery are measured on
  the selected host. Long-term capacity qualification is deferred by the user
  on 2026-10-08 JST and is not a completion gate for this preview.
- [x] All P0 evidence is linked, versioned and redacted; no production/mainnet,
  ceremony, audit or full I10/G1-G4 claim is inferred from a Devnet preview.

The [N-01 service recovery](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-service-recovery.md) retained the
acknowledged reservation, signed settlement, database cut and original journals
through admission suspension, capture, same-state restart and resume. It also
records actual host memory/disk and cold-replay observations, including failures.
[Independent backup verification](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-backup-independent-verify.md)
later verified the complete encrypted archive and restored its original
one-session logical database in isolated PG16. This is not restoration of the
later four-session state, physical services or signer state. These checked
items concern the measured preview scope. Published `.3` releases/profile,
isolated public-input setup and the N-01–N-04 evidence identify the exact supported
macOS/native/OpenClaw combination and its limitations. [E01 emergency escape/finalize](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-E01-emergency-withdrawal-20261009.md)
now closes the original one-micro-USDC note with independently verified finalized
transactions and unchanged operator financial state. The [core completion record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-core-completion-20261009.md)
joins the final public readiness observation and evidence handoff in this documentation update.
Funded browser evidence is deferred.
The installed [OpenRouter policy](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-ethereum-parity.md),
[warm restart](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-warm-restart-20261009.md),
[writer successor](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-replay-writer-deployment-20261009.md), and
[public restoration/preflight](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-restoration-20261009.md) now
have separate receipts preserving all failed observations and financial state.
[Current capacity](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-capacity-retained-20261009.md) records the retained
80 GiB volume and measured headroom without a migration or long-term claim.

## PD-11 — Keep broader follow-ups explicit

These are separate from proving the first public Chat integration:

- Additional live providers/APIs, multi-model combinations and the remaining
  I10 acceptance matrix; do not silently drop direct/proxy requirements.
- Claude Code and Codex compatibility: current production request-shape blockers
  are recorded in [integration docs](integrations/README.md). Design versioned
  supported subsets and real handler/provider acceptance before advertising them.
- Linux, Windows, Intel macOS distributions and Apple signing/notarization.
  The existing verified package is macOS ARM64; other-platform support is not
  proven by it.
- Portable browser custody backup/migration, origin changes and note lifecycle
  UX; keep current storage limitations visible.
- Production setup/ceremony, independent review/audit, authority policy,
  infrastructure isolation/fencing/KMS, production recovery drills, full
  release gates and subsequent mainnet deployment under I11/I12.
- npm registry publication is optional distribution work, not the definition
  of a usable SDK.

## Suggested execution order and completion record

1. Revalidate the baseline, select the public Devnet operator/setup and resolve
   artifact redistribution (PD-01/02). Existing evidence is input, not a reason
   to rebuild the protocol.
2. Freeze the compatible public profile, transport, model/tariff and access/
   funding policy (PD-03 through PD-06).
3. Retain the completed isolated public-input onboarding and read-only validation
   (PD-07), with its same-host rather than pristine-OS scope explicit.
4. Retain completed N-01–N-04 native evidence (PD-09), E01 escape/finalize,
   the installed OpenRouter policy and public restoration. Do not replay
   historical inference or completed wallet operations. PD-08 is deferred.
5. Retain the completed core operations/evidence handoff (PD-10); schedule PD-11 separately.

For every task, append or link an evidence record under `docs/evidence/`
containing: task ID, owner, source/release/profile hashes, commands, environment,
public artifacts, expected/observed results, failures, remaining limitations and
any financial test's budget/transaction/receipt references. Do not publish
secrets, custody files, private RPC credentials or raw private journals.

Final acceptance is a fresh independent consumer completing the documented
public Devnet lifecycle from public inputs. A build, mock UI response, HTTP 200
health check, faucet transaction, earlier private-profile success or a published
SDK tarball alone does not satisfy it.

## Dated resume checkpoint — 2026-10-08 11:45 UTC

The [same-state service-recovery evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-service-recovery.md) records successful admission resume after a fresh preflight/operator cut and two full readiness checks. Earlier failed attempts remain immutable; the public response confirms configuration only. The one-reservation/six-micro-USDC figures describe the pre-resume cut, before the N-02/N-03 launch at approximately 11:48 UTC. No OpenClaw result, later budget count, withdrawal, backup restore or new checklist closure is inferred from this checkpoint.
