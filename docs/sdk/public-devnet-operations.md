# Public Devnet operator status and incidents

The repository maintainer coordinates this invitation-only preview and its
operator account. Operation is manual: there is no staffed support schedule,
uptime commitment or long-term service-level objective. Ask the operator through
the maintainer's existing private communication channel for access, an operating
window or an incident update. No public invitation code or response-time promise
is offered.

The hosting target is approximately **USD50/month**, not a billing hard cap.
The [AWS cost guide](../../deploy/public-devnet/aws-budget-host.md) separates
fixed estimates from variable usage and taxes. Provider credit has a separate
authorized seven-USDC acceptance ceiling, described in the
[funding guide](devnet-funding.md). A hosting target does not renew that allowance.

## Dated operational checkpoints

These observations do not establish availability at the time of reading:

| UTC checkpoint on 2026-10-08 | Established scope |
|---|---|
| 06:54 | [Native N-01](../evidence/PD-native-public-N01.md) completed a finalized Devnet deposit, one Chat response and SDK-verified settlement. Its note remained active with 4,999,994 micro-USDC. |
| 07:43 | The [read-only operator join](../evidence/PD-N01-operator-join.md) matched the exact AUTH, retained reservation and signed charge. The following local draft assembly failed; that report did not approve a suspension. |
| 07:58 | A later approved suspension changed only `allowNewAdmissions` to false and retained the one reservation. A public status read at 07:58:49 UTC returned HTTP200, `admission: suspended` and `recovery: enabled`. |

The retained suspension result has SHA-256
`b745ae3a4d10512861252603990390b01082616754e561f88d22b0241f2cf7e4`;
the public status observation has SHA-256
`3bb8f592c3dad676ed23c0d0adee1a4cc6ae2fbb39127733c01de3dc20ffb196`.
Maintenance followed this checkpoint. Its first capture attempt stopped at a
file-inventory check after services were stopped; a successful encrypted backup,
restart or admission resumption is not established here. Keep the active note
and its original custody. A prior HTTP200 is not a current health check.

## Admission and recovery are separate

Use the independently pinned [deployment profile](public-devnet-preview.md), then
run read-only preflight and inspect the public
[`/relay-status`](https://d366buuvadnp3.cloudfront.net/relay-status) response.
Preflight verifies deployment and chain inputs; it does not reserve a provider
slot or prove that your invitation will be accepted.

`admission: suspended` prevents new AUTH. It preserves existing exact reserved
AUTH and settlement identities; it does not authorize a fresh request UUID.
`recovery: enabled` describes the gateway policy for existing work. Recovery,
settlement and withdrawal still depend on their required services and chain
state. Maintenance may stop those services temporarily, even though their state
is retained. A timeout or HTTP503 never authorizes inference replay.

## Incident and maintenance procedure

1. **Consumer: stop new work and preserve evidence.** Keep the original wallet,
   note, encrypted journal, profile and pending operation. Save the UTC time,
   redacted error category and public deployment identity. Share an operation ID
   privately if the operator needs it; never send an invitation, token, seed,
   decrypted journal or provider response in a public issue.
2. **Operator: publish a dated scope.** State whether new admission is suspended,
   which recovery dependencies are unavailable, and the next manual update when
   known. Distinguish observed HTTP/chain results from an expected recovery time.
   A successful single response does not establish an availability window.
3. **Operator: retain the same authority.** Follow the
   [same-state maintenance runbook](../../deploy/public-devnet/same-state-restart.md).
   Preserve all reservations, custody, database, signer and journal history;
   inspect failed or uncertain steps before a separately reviewed continuation.
   Do not initialize replacement state, discard failed evidence or automatically
   repeat a financial action.
4. **Consumer and operator: resume deliberately.** After the required services
   have returned and fresh profile/chain checks pass, use the original journal's
   explicit [recovery procedure](recovery.md). Recovery must not replay inference.
   New work requires a separate admission reopening, valid invitation and remaining
   authorized capacity; withdrawal must be verified as finalized.

The [readiness backlog](../public-devnet-readiness-backlog.md) keeps full lifecycle,
backup/restart and required fault-injection acceptance separate. This procedure
does not certify those checks, or claim continuous operation for a month.
