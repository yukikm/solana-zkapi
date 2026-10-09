# Retained preview capacity — 2026-10-09

Read-only AWS inspection at **2026-10-09 00:15:55 UTC** confirmed the existing
**t3a.medium with Standard CPU credits**, an **80 GiB gp3 data volume** and a
**20 GiB gp3 root volume**. Both volumes were encrypted and in use. This inspection
made **no resource changes**. The saved result rehashes to
`23bf59f8b8653fbd4efd3f5c059a6903998836950642a5d19e506acdd252629d`; the [JSON record](PD-capacity-retained-20261009.json)
pins the private inputs while omitting AWS resource identifiers.

The data volume remains at the size established by the earlier
[40-to-80-GiB expansion](PD-preview-capacity-80g.md). Its retention is an observed
current state, not a completed rollback or a newly approved migration. The storage
clarification had no recorded user answer at this checkpoint; the operating
assumption to keep 80 GiB while preserving history was communicated. A return to
40 GiB remains a separate migration follow-up, without a new decision inferred
from the user's silence.

## Saved headroom observations

Six successful read-only runtime observations followed the
[writer-only throughput installation](PD-replay-writer-deployment-20261009.md).
The timestamps below are observation start timestamps on 2026-10-09 UTC; each
collector completed a few seconds later. They read available space on the data
filesystem, not the nominal EBS volume capacity.

| Observation | UTC | Available bytes | Durable archive blocks | Finalized slot gap |
| --- | --- | ---: | ---: | ---: |
| 01 | 00:04:58 | 32,788,254,720 | 442,757 | 25,392 |
| 02 | 00:07:54 | 32,400,195,584 | 446,456 | 22,396 |
| 03 | 00:14:30 | 31,570,726,912 | 456,157 | 14,310 |
| 04 | 00:18:18 | 31,094,652,928 | 461,617 | 9,746 |
| 05 | 00:22:09 | 30,613,213,184 | 466,829 | 5,493 |
| 06 | 00:25:35 | 30,190,022,656 | 471,616 | 1,520 |

The latest saved observation began at **00:25:35 UTC** and completed at
**00:25:41 UTC**, reporting **30,190,022,656 available bytes**. Writer/follower
unit identities remained equal across all six cuts; each observer reported zero
service and financial actions, zero journal jobs and zero transport records.
These are catch-up observations. Their decreasing free space is not extrapolated
as the steady ingestion rate or an exhaustion forecast.

At observation 06 the stored writer health still came from its startup snapshot,
approximately 1,350 seconds earlier, and reported `ready: false`. The independently
observed archive gap had narrowed to 1,520 slots. Those two measurements have
different timestamps; this capacity record does not establish fresh readiness,
gateway restoration or continuous availability.

## Why no 40-GiB rollback is claimed

The earlier [verified warm restart](PD-warm-restart-20261009.md), receipt
`e6d05884e36fc678d35611a49b7cce1ced7115430d7bc459d304cbfd60909f95`,
records **46,673,163,486 bytes** of committed writer archive payload before the
successor's later append activity. That payload alone already exceeded
**42,949,672,960 bytes (40 GiB)**. It is a committed-payload measure, not total
filesystem usage; these capacity observers did not recalculate a latest complete
archive byte total.

No data migration, volume shrink, history pruning or storage rollback was
performed by this work, and the observations do not demonstrate a safe path back
to 40 GiB. The full history and financial state remain subject to the preservation
rules in the warm-restart and deployment evidence. The earlier cost illustration
is retained in the expansion record; this readback does not claim new pricing,
an actual bill reduction or a completed cost rollback.

Continued chain ingestion still grows the retained archive. Current headroom,
checkpoint recovery and the catch-up interval do **not** establish 30-day capacity
qualification, a retention policy or a service availability commitment. Long-term
qualification remains outside the selected core preview scope. Writing these
local evidence files performed no AWS, host, wallet or financial action.
