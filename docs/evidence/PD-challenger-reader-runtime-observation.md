# Actual disk-reader startup and bounded catch-up observation

The existing AWS challenger resumed on 2026-10-07 at 21:07:57 UTC with the reviewed disk-backed reader, the same archive, configuration and owner lock. Its committed history advanced after cold replay. The observed memory and write costs were substantially lower, but public readiness remained incomplete because RPC errors interrupted both consumers. This report does not establish admission, funded acceptance or sustained capacity.

The [machine-readable report](PD-challenger-reader-runtime-observation.json) pins the retained private observations. The [preceding offline host check](PD-challenger-disk-reader-host-check.md) and [original segmented migration](PD-challenger-segmented-migration.md) remain separate evidence; no second migration or history reset occurred.

## Same-authority startup

The installed challenger unit originally wanted `zka-control.service`. The first isolation attempt stopped before changing that installed unit: `systemctl show` returned the same dependency sets in a different order, failing a raw-string comparison. Its original fragment, candidate, validation outputs and prepared record remain retained. A separately reviewed continuation authenticated all five files, compared dependency sets, and removed only the single `Wants=zka-control.service` line. It then reloaded systemd without starting either service.

The subsequent single challenger start observed control still inactive. The original unit is retained and must be restored before boot-enable or restart acceptance. This temporary isolation changes no runtime configuration, archive, financial authority or admission setting.

The first observed new committed prefix at 21:14:50 UTC contained 30,020 blocks in 118 chunks, ending at slot 508550502. The initial cold-replay health file was stale and was not used as a catch-up rate measurement.

## Bounded measurements

A complete 37-sample guard from 21:14:06 to 21:17:07 observed maximum process RSS/HWM of 47,091,712 bytes and minimum host available memory of 3,350,540,288 bytes. It recorded no protection stop or review condition. The complete output is retained on the host with a SHA-256 pin. The preceding guard's SSM inline output was truncated at 24KB; that limitation is preserved rather than presented as complete sampled evidence.

The separate steady window from 21:15:28 to 21:18:28 measured:

| Measurement | Observed value |
| --- | --- |
| Elapsed time | 180.201 seconds |
| Committed progress | 901 slots / 887 blocks |
| Mean slot progress | 5.00 slots per second |
| Mean process CPU | 0.0402 CPU cores |
| Mean process writes | 0.447 MB per second |
| Archive growth | 80,381,081 bytes |
| Remaining data space at window end | 13,828,476,928 bytes |
| Health lag | 8,688 to 8,661 seconds |

These are short observations, not a memory peak for the whole cgroup, a catch-up ETA, a storage retention policy or a long-running capacity qualification. The three individual minutes advanced 417, 324 and 160 slots; the variability matters when assessing readiness.

## Remaining RPC restriction

The challenger recorded actual `getBlock` HTTP 429 responses and the existing ten-second cooldown. At 21:17:42 both local indexer root and snapshot endpoints returned HTTP 503. A read-only process and log check at 21:20:28 confirmed the indexer had not restarted: it retained its original start slot and its successful-prefix cursor continued advancing. Its installed log format reports generic HTTP errors, so this report does not assign an unrecorded numeric status to those errors.

The exact installed indexer source preserves its in-memory index and cursor across refresh failures. Each refresh requires a fresh finalized account reconciliation and withholds the previous cut while incomplete. A process restart would still replay from the configured start slot. No restart, cursor advance, history omission, provider purchase or paid RPC upgrade was performed to produce this observation.

Admission remained suspended, control remained inactive, and sampled challenger pending jobs and unknown signatures remained zero. Catch-up, fresh reconciliation, control readiness, restoration of the original unit, installed-client acceptance, protected backup and same-state restart remain separate work.
