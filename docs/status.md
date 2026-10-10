# Support and verification status

This summary uses evidence recorded through **2026-10-10 JST**. Each result applies
to its recorded source, client and deployment. It does not establish current
availability or a pass for later source changes.

Published SDK/native clients are **`0.2.0-devnet.8`**. Start with
[clientd installation](getting-started/clientd.md) or the
[SDK quickstart](getting-started/sdk.md). Use the
[upgrade procedure](getting-started/upgrading.md) for existing installations.

The public service's latest recorded read-only check was **2026-10-10 19:07 JST**:
readiness returned HTTP 200, admission was enabled without an invitation, all ten
installed `.8` preflight checks passed, and discovery returned 21 models.
Archive disk exhaustion had interrupted the catalog; storage and service repairs
restored it. The preview now uses operator-funded usage without a fixed trial
allowance. These checks did not perform new funded inference or wallet actions.
Run fresh preflight before use; no uptime or provider-credit guarantee is implied.

## Recorded results

| Area | Verified scope | Limit |
|---|---|---|
| Distribution | [SDK `.8` tarball and macOS ARM64 clientd](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-sdk8-publication-20261010.md): release signatures, downloads and installed-file hashes | No npm release, Apple notarization or verified packages for other platforms |
| Public API | [Invitation removal](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-invitation-removal-20261009.md) and [browser CORS](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-cors-20261009.md); catalog, public HTTP200 readiness, admission and all ten installed `.8` preflight checks passed after the disk repair | Read-only checks at the stated cut; no new funded lifecycle or uptime commitment |
| Models and capacity | [Revision-6 profile](releases/usability-preview.md) retains 21 models; the gateway now reports operator-funded usage without a fixed trial allowance | Listing is not inference acceptance or a provider-credit check. The seven historical reservations remain consumed |
| Native lifecycle | [N-01](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N01.md) deposit and Chat; [N-02/N-03](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md) OpenClaw text/read-tool continuation; [N-04](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N04.md) interrupted-stream recovery and withdrawal | Selected OpenRouter cases using the settlement adapter; not general client/provider compatibility |
| Emergency withdrawal | [E01](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-E01-emergency-withdrawal-20261009.md) returned the original one micro-USDC and closed the note | Completed from its original deposit/journal; do not repeat it |
| Browser SDK | Local custody/proof-worker tests and [separate-origin preflight](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-runtime-origin-followup.md) | Current funded browser/Phantom acceptance is deferred |
| Direct-session reuse | [Included since `.6`](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-sdk6-publication-20261009.md); local tests cover leases, settlement and recovery | No funded `.6`–`.8` lifecycle is established by these tests |
| Privacy and upgrade guidance | [`.7` request filtering and journal minimization](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-sdk7-publication-20261010.md), [`.8` local upgrade plans and privacy status](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-sdk8-publication-20261010.md) | ZDR routing is not proof of provider deletion; existing custody is not migrated |
| Backup and restart | [Warm restart](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-warm-restart-20261009.md) and [independent backup restoration](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-backup-independent-verify.md) | Backup restoration covered the original one-session N-01 database, not later financial state or physical services |
| Hosted CI | [Both `.8` client CI jobs passed](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-sdk8-publication-20261010.md) | Full implementation CI was still running at the recorded cut; no all-job pass is claimed |

## Remaining limits

- **Provider accounting:** the installed [OpenRouter policy](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-ethereum-parity.md)
  captures management usage after disabling the key and waiting five seconds,
  then confirms deletion before signing a capped charge. Delayed accounting is
  the operator's risk. The [historical cost discrepancy](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-management-usage-limit.md)
  remains unresolved; existing signed charges are not repriced.
- **Capacity:** retained chain history continues to grow. The
  [80 GiB data-volume checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-capacity-retained-20261009.md)
  does not establish long-term capacity or a completed storage rollback.
  [Lossless archive compression and a database headroom floor](getting-started/operators/archive-storage.md)
  reduce growth and prevent archive writes from consuming the reserved headroom;
  finite storage still requires ongoing capacity management.
- **Client compatibility:** tested Claude Code and Codex CLI requests hit
  validation blockers. See the [compatibility table](integrations/README.md).
- **Release scope:** production qualification, mainnet, audits and the full
  provider/browser acceptance matrix remain incomplete. Initial APIs cover
  text and client-executed tools; media, Realtime, hosted tools, persisted
  provider conversations, Ollama and native SOL billing are outside this scope.

See the [public deployment guide](getting-started/public-devnet-preview.md) for
current downloads and fresh preflight, [operations](getting-started/operators/incidents.md)
for incidents, and the [verification policy](development/verification.md) for
historical records and the scope of test results.
