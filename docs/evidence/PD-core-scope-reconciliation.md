# Core preview scope and existing acceptance evidence

Scope reconciliation, 2026-10-09 JST. The user directed work to finish ZKAPI
core and stop demo/chat UI work. Funded browser/Phantom cases B-01–B-03 and
PD-08 are deferred, not completed and not gates for this core preview. Existing
browser custody, failed operations and immutable app releases remain preserved.
Conversation storage and UI presentation belong to the consuming application.

The [native N-01](PD-native-public-N01.md),
[OpenClaw N-02/N-03](PD-native-public-N02-N03.md) and
[N-04 recovery and withdrawal](PD-native-public-N04.md) already establish their
recorded public native path. [Public readiness deployment](PD-public-readiness-deployment.md),
[same-state service recovery](PD-N01-service-recovery.md) and
[historical N01 backup/logical restoration](PD-N01-backup-independent-verify.md)
retain their distinct scopes. They do not need to be repeated to complete a demo UI.

## Public-input onboarding

The published `.3` native archive was downloaded into a fresh directory outside
the checkout, checked against its release manifest and 7,257 file hashes, and
used with an empty consumer HOME/TMPDIR and restricted PATH. The shipped public
profile helper passed ten read-only checks. Its first input-installation attempt
then failed snapshot validation; that failure remains preserved with cause
unknown. A separate successful diagnostic did not establish that cause.

An explicit input-installation continuation passed at **15:18:11 UTC**, followed
by the released `clientd setup` at **15:25:22 UTC** on 2026-10-08. The retained
results and derived input hashes were rechecked during this audit. Setup created
the new profile without starting custody or executing financial commands.
This is actual same-host, isolated public-input consumption; it is not a pristine
operating-system or another-platform test. The current PD-01/PD-07 checklist credits this exact installation scope. The
original broader clean-machine wording does not establish a pristine-OS test and
is not used to create another paid lifecycle.
The [JSON record](PD-core-scope-reconciliation.json) pins the receipt hashes.

## Production rejection and local guards

The earlier [actual Claude Code probe](I10-coding-client-configuration.md) reached
the production Go frontend and received HTTP400 `unsupported_route` before
backend dispatch. All four source hashes in that report still match, including
the Go handler used by the `.3` build. This is a verified rejection, not Claude
compatibility. The earlier Codex rejection remains historical: two of its SDK
source files have changed, so its entire old source snapshot is not relabeled
as current.

The actual `.3` SDK validation passed **385/385 tests**, with all 75 guarded
inputs still matching. Existing production SDK tests reject unsupported APIs,
identity/transport metadata and modalities before AUTH, and cover quote/tariff
binding, stream cancellation, terminal usage and durable no-replay recovery.
These use local dependencies; they are not additional provider requests.
Together with actual N-04 recovery and the exact Go rejection, they support
PD-09's recovery/unsupported-handler behavior. The unrelated first OpenClaw
HTTP400 still has an unproven cause and is not used to close that item.

Readiness behavior has targeted stale-indexer, signer and disabled-provider
fixtures plus the deployed endpoint's actual `indexer: unavailable` observation
and later successful projection. This does not claim live injection of every
branch. This evidence closes the specific-reporting behavior in PD-01 while keeping
untested live fault branches explicit; no paid fault matrix or provider-disable
feature is required. N-02–N-04 plus the released SDK terminal-usage/cancellation
fixtures close the advertised stream behavior. Ed25519/tariff/cap snapshot guards
and the native local-credential boundary close PD-05 price/secret handling.
The exact funding instructions and actual native deposits support PD-06 guidance.
PD-06 error recovery stays open until the current E-01 outage is resolved; PD-10
final publication remains open until the remaining outcomes are linked.

## Remaining boundary

The separate **E-01 zero-AUTH voluntary escape/finalize exercise remains
incomplete**. Its setup is verified above; the subsequent deposit attempt has an
unresolved receipt observation and establishes no finalized escape or payout.
Successful mutual withdrawal does not establish this current-public-profile
path. Final core handoff must record its actual outcome and link the evidence.

The user's subsequent instruction selects [Ethereum's OpenRouter capture policy](PD-openrouter-ethereum-parity.md).
The earlier assessment added a stronger final-invoice/completeness condition;
that condition is superseded for the core preview. Disable the key, wait the
configured grace, capture the valid management `usage + byok_usage`, persist it,
confirm deletion, then sign the capped immutable charge. Accounting delay and
unobserved costs are the operator's risk. Missing usage is not zero; finalized
sessions are not repriced. The exact Solana decimal/receipt protections remain.

The local parity runtime is a candidate until deployment is recorded. Historical
N-02/N-03 signed zeros and the [client-retained response-cost discrepancy](PD-openrouter-management-usage-limit.md)
remain unchanged. This policy does not assert invoice accuracy, measure all
operator loss or close broader G3. It requires no new reconciliation service or
paid matrix. E-01, candidate deployment evidence and the final core handoff are
the concrete remaining work. No UI, pristine-OS or long-term qualification is
added by this audit; no historical inference is replayed.
