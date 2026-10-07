# AWS preview RPC and startup capacity observations

These are bounded measurements from the new AWS preview on 2026-10-07 UTC. They do not establish funded acceptance, a production SLO, or sustainable long-term capacity. The preserved bootstrap and candidate history is in [the operator report](PD-aws-operator-bootstrap.md); exact observed inputs are joined in [the companion JSON](PD-aws-rpc-capacity.json).

| UTC observation | Result | Implication |
| --- | --- | --- |
| Before the unchanged-alert fix | A 180.269-second sample advanced only 40 slots while the process wrote 9.864 GB. | Unchanged alerts caused avoidable complete archive writes. |
| After unchanged-alert persistence was removed | A separate 180.251-second sample advanced 832 slots, about 4.62 slots/second; process writes still averaged 42.788 MB/second. | The fix improved that window, while actual archive append persistence still rewrote growing history. |
| 19:24, exact safe RPC diagnostics | Actual `getBlock` HTTP 429 responses, with the existing shared ten-second cooldown; the configured provider was classified as Alchemy without revealing the URL. | Throttling is observed. The account tier, quota and other account workload remain unknown. |
| 19:30:18 | Only the empty new AWS control was stopped cleanly, after zero financial database rows, zero notes/pending withdrawals, zero challenger jobs/unknown signatures, and suspended admission were verified. | This was a bounded startup diagnostic. Original local state and other services were preserved. |
| 19:30:19–19:34:57 | Ten further `getBlock` HTTP 429 events; no RPC code or timeout in those events. | Pausing the new control did not eliminate throttling. |
| 19:33:00–19:36:00 | 684 slots in 180.332 seconds, about 3.79 slots/second; journal grew 60.801 MB while process writes averaged 39.098 MB/second and CPU averaged 0.499 core. | This window did not demonstrate catch-up capacity. |
| 19:33:01, one bounded query | The latest observed 1,000-slot finalized interval contained 1,000 produced blocks; `getBlocks` returned HTTP 200 in 127 ms. No full blocks were fetched by this probe. | The sampled interval was dense; skipped slots did not reduce its replay demand. |
| 20:05:02 | Challenger stopped cleanly, preserving its 2,912,440,894-byte v1 journal and original owner lock. | The explicit offline archive migration can validate this frozen source without growing it during preparation. |

An earlier pre-stop snapshot request returned HTTP 503; that failed attempt performed no stop. Its retained observation is separate from the successful fresh check and clean stop. No history was skipped or reset, no instance or CPU-credit mode was upgraded, and no new paid RPC subscription was introduced. The current Standard CPU-credit balance is a separate measured capacity constraint, not evidence of a known RPC quota.

The [segmented archive migration and independent cold-open verification](PD-challenger-segmented-migration.md) subsequently passed while the service stayed stopped. Subsequent reader changes and resumed throughput require separate evidence; these pre-migration observations do not establish that storage conversion has solved RPC limits or completed catch-up.
