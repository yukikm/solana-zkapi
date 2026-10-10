# Public Devnet operations and incidents

The repository maintainer operates the preview manually. There is no staffed
support schedule or uptime commitment. Contact the maintainer through the
existing private channel for operating windows or incident updates.

## Recorded status

As of the **2026-10-10 JST** evidence:

- The API [no longer requires invitations](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-invitation-removal-20261009.md).
  All seven historical provider request slots were consumed at the
  [model-profile deployment](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-model-expansion-20261009.md).
  The operator separately removed the fixed trial allowance on 2026-10-10;
  old grant records remain unchanged. See [funding and access](devnet-funding.md).
- The [publication preflight](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-sdk8-publication-20261010.md) failed
  on an empty operator catalog with both `.7` and `.8`. Later inspection found
  archive disk exhaustion affecting PostgreSQL. Lossless compression restored
  disk headroom. Chain recovery and bounded readiness-read repairs completed,
  and admission reopened at 10:07 UTC on 2026-10-10. All ten installed `.8`
  read-only preflight checks and 24 repeated public API reads passed; see
  [current status](status.md) for the scope and remaining limits.
- Native recovery and withdrawal, E01 emergency withdrawal and service restart
  have [scoped evidence](status.md). These are completed historical operations,
  not instructions to replay them.

The hosting target is approximately USD50/month, not a billing cap. See the
[AWS cost guide](../../deploy/public-devnet/aws-budget-host.md) and
[retained-capacity record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-capacity-retained-20261009.md). The
80 GiB data volume remains retained and chain history continues to grow;
returning to 40 GiB requires a verified migration. Hosting costs and provider
spending are separate. The [archive storage procedure](../../deploy/public-devnet/archive-storage.md)
documents lossless compression, database headroom and rollback requirements.

Earlier checkpoints, including the failed backup preparation and suspension,
are preserved in the [documentation archive](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-documentation-cleanup-20261010.md)
and [service-recovery record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-service-recovery.md).

## Admission and recovery are separate

Use the pinned [deployment profile](public-devnet-preview.md), run fresh
read-only preflight and inspect these endpoints on the public API origin:

| Check | What it tells you |
|---|---|
| Preflight/readiness | Deployment and service checks; no provider-slot reservation |
| `/relay-status` | Configured admission, invitation and recovery policy |
| `/provider-budget` | Operator-funded policy without a trial counter, or remaining finite allowance; not provider credit |

`admission: suspended` blocks new AUTH while retaining existing reserved AUTH
and settlement identities. `recovery: enabled` describes policy; recovery,
settlement and withdrawal still need their services and chain state available.
Maintenance can interrupt those dependencies. A timeout or HTTP503 must not
trigger inference replay.

## Incident and maintenance procedure

1. **Stop new work and preserve the original state.** Keep the wallet, note,
   encrypted journal, profile and pending operation. Save the UTC time and
   redacted error. Share operation IDs privately; never post tokens, seeds,
   decrypted journals or provider responses.
2. **Publish a dated incident update.** The operator should state which services
   and recovery paths are unavailable, whether new admission is suspended and
   when another update is expected, if known.
3. **Retain the same authority.** Follow the
   [maintenance runbook](../../deploy/public-devnet/same-state-restart.md).
   Preserve reservations, custody, database, signer and journal history. Review
   failed or uncertain steps before continuing; do not initialize replacement
   state or repeat financial actions automatically.
4. **Recover before resuming.** Once services and fresh profile/chain checks
   pass, use the original journal's [recovery procedure](recovery.md). New usage
   also requires open admission and available provider capacity. Confirm
   withdrawals as finalized.

The [readiness backlog](../public-devnet-readiness-backlog.md) records outstanding
acceptance and long-term operating work.
