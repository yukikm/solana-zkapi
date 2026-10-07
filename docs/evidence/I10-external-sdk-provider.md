# Independent application SDK provider cases — 2026-10-07 JST

Five direct OpenRouter Chat requests from the independent application received
HTTP 200, and all five sessions subsequently settled. Response consumption
passed for plain text, the tool call, and the separate request using the corrected
SSE parser. The two earlier SSE attempts remain failed or unverified; HTTP
success and eventual settlement do not make their response consumption a pass.

The [public report](I10-external-sdk-provider-results.json) joins each operation
UUID from the initial saved SDK status to the exact UUID in a later successful
`status.lastSettlement.operationIds`, with `status.session === null`. It retains
59 original command/settlement result files and five allowlisted management
projections, with individual SHA-256 hashes in the report.

| Case | HTTP | Response consumption | Later SDK charge (micro-USDC) | SDK package |
|---|---|---|---:|---|
| `plain` | 200 | Completed: 6 characters | 4 | Initial |
| `sse` | 200 | Not established; original failure cause unproven | 4 | Initial |
| `tools` | 200 | Completed: one `echo` tool call validated | 0 | Initial |
| `sse-validation` | 200 | Failed after 13 characters / 3 deltas; confirmed terminal-usage parser error | 0 | Initial |
| `sse-fixed` | 200 | Completed: 16 characters / 3 deltas with the corrected reader | 0 | Corrected |

The initial package SHA-256 is
`3e601fae1d41a804a3c59b10c0eb88052bbedd0ba9317ad88e7cdb9fad06ebbd`;
the corrected package SHA-256 is
`fc37358ce00fa7bcb5c43367c8f09b3908c617f9235e8646ae78003a21040c91`.
Only the separate `sse-fixed` operation ran after the package replacement. Both
retained tarball hashes were checked. Earlier cases do not retroactively
validate the corrected package. The [parser evidence](I10-sdk-sse-parser.md)
preserves the captured failure, offline reproduction, strict correction and
regressions; no private provider response body is included here.

Every initial case command reported failure while its session was still closing.
For `tools` and `sse-fixed`, the recorded failure stage was the final settlement
assertion, after response validation had completed. The plain result retained a
completed text-read count but predates failure-stage diagnostics. Subsequent
explicit settlement commands used the existing sessions and did not replay the
inference. The final saved counters report **five AUTH sends, five inference
sends and zero inference replays**. These are harness counters, not independent
network packet counts. Their SDK charges total **8 micro-USDC**, leaving the
settled note balance at **1,999,992 micro-USDC** before withdrawal.

Five local SELECT snapshots through `i10_provider_reader` used
`transaction_read_only=on`, a 5-second statement timeout and a 3-second lock
timeout. The collector used the existing
[`query(request_id)` scalar projection](../../scripts/i10_collect_direct_lifecycle.py)
for the actual session IDs, without constructing legacy acceptance cases or
calling their case validator. Each projection records one finished issuance
attempt, a settled session with no reserved usage or active operations, and
final usage before the saved deletion checkpoint. The reported session charge
matches the exact SDK settlement.

Plain and the first SSE case each retained `OPENROUTER_USAGE` of 3,150 nano-USDC,
rounded to a 4-micro-USDC SDK charge. Tools, validation and corrected SSE each
retained **zero `OPENROUTER_USAGE`** and a zero SDK charge. Those zero observations
do not prove free inference, absence of provider resource use, or absence of
later provider billing. Checkpoint history corroborates saved runtime state;
this collector neither observes independent provider packets nor revalidates
cryptographic signatures.

Collection made no provider calls, chain sends, database writes, budget changes
or journal reads. It did not read wallet files, passphrases or private response
bodies. Withdrawal and native/OpenClaw acceptance are separate evidence. These
five cases do not establish Phantom, other APIs/models/providers, mainnet,
signed public release hosting, full I10 or G1–G4.
