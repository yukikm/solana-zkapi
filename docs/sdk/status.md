# Support and verification status

This summary uses evidence recorded through **2026-10-10 JST**. Each result applies
to its recorded source, client and deployment. It does not establish current
availability or a pass for later source changes.

Published SDK/native clients are **`0.2.0-devnet.8`**. See the
[release guide](../releases/usability-preview.md) for downloads, the revision-6
profile and handling of older installations. **The latest recorded public
preflight failed on an empty operator catalog** with both `.7` and `.8`.
New-consumer readiness has not been established.

## Recorded results

| Area | Verified scope | Limit |
|---|---|---|
| Distribution | [SDK `.8` tarball and macOS ARM64 clientd](../evidence/PD-sdk8-publication-20261010.md): release signatures, downloads and installed-file hashes | No npm release, Apple notarization or verified packages for other platforms |
| Public API | [Invitation removal](../evidence/PD-invitation-removal-20261009.md) and [browser CORS](../evidence/PD-public-cors-20261009.md) | Later `.8` preflight failed on an empty catalog; cause and long-term availability remain unverified |
| Models and capacity | [Revision-6 profile](../releases/usability-preview.md) retains 21 models; a separate public ZDR metadata read listed 19 | Listing is not inference acceptance. All seven authorized request slots were consumed |
| Native lifecycle | [N-01](../evidence/PD-native-public-N01.md) deposit and Chat; [N-02/N-03](../evidence/PD-native-public-N02-N03.md) OpenClaw text/read-tool continuation; [N-04](../evidence/PD-native-public-N04.md) interrupted-stream recovery and withdrawal | Selected OpenRouter cases using the settlement adapter; not general client/provider compatibility |
| Emergency withdrawal | [E01](../evidence/PD-E01-emergency-withdrawal-20261009.md) returned the original one micro-USDC and closed the note | Completed from its original deposit/journal; do not repeat it |
| Browser SDK | Local custody/proof-worker tests and [separate-origin preflight](../evidence/PD-public-runtime-origin-followup.md) | Current funded browser/Phantom acceptance is deferred |
| Direct-session reuse | [Included since `.6`](../evidence/PD-sdk6-publication-20261009.md); local tests cover leases, settlement and recovery | No funded `.6`–`.8` lifecycle is established by these tests |
| Privacy and upgrade guidance | [`.7` request filtering and journal minimization](../evidence/PD-sdk7-publication-20261010.md), [`.8` local upgrade plans and privacy status](../evidence/PD-sdk8-publication-20261010.md) | ZDR routing is not proof of provider deletion; existing custody is not migrated |
| Backup and restart | [Warm restart](../evidence/PD-warm-restart-20261009.md) and [independent backup restoration](../evidence/PD-N01-backup-independent-verify.md) | Backup restoration covered the original one-session N-01 database, not later financial state or physical services |
| Hosted CI | [Both `.8` client CI jobs passed](../evidence/PD-sdk8-publication-20261010.md) | Full implementation CI was still running at the recorded cut; no all-job pass is claimed |

## Remaining limits

- **Provider accounting:** the installed [OpenRouter policy](../evidence/PD-openrouter-ethereum-parity.md)
  captures management usage after disabling the key and waiting five seconds,
  then confirms deletion before signing a capped charge. Delayed accounting is
  the operator's risk. The [historical cost discrepancy](../evidence/PD-openrouter-management-usage-limit.md)
  remains unresolved; existing signed charges are not repriced.
- **Capacity:** retained chain history continues to grow. The
  [80 GiB data-volume checkpoint](../evidence/PD-capacity-retained-20261009.md)
  does not establish long-term capacity or a completed storage rollback.
- **Client compatibility:** tested Claude Code and Codex CLI requests hit
  validation blockers. See the [compatibility table](../integrations/README.md).
- **Release scope:** production qualification, mainnet, audits and the full
  provider/browser acceptance matrix remain incomplete. Initial APIs cover
  text and client-executed tools; media, Realtime, hosted tools, persisted
  provider conversations, Ollama and native SOL billing are outside this scope.

See the [public deployment guide](public-devnet-preview.md) for downloads and
fresh preflight, and the [readiness backlog](../public-devnet-readiness-backlog.md)
for outstanding work. Earlier [I10 evidence](../evidence/I10.md),
[independent integration results](../evidence/I10-external-integration.md) and
[archived documentation](../evidence/PD-documentation-cleanup-20261010.md) retain
historical successes, failures and their original verification boundaries.
