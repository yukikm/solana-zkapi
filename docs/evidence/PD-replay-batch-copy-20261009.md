# Batched replay without per-block history copies

Recorded 2026-10-09 JST. This is a **locally verified candidate**, before any
successor deployment recorded elsewhere. It removes the writer catch-up loop's
copy of the complete Scanner for every accepted block. It does not establish
elapsed host speed, current public readiness or E01 completion. The earlier
[installed checkpoints](PD-restart-checkpoints.md) and
[actual same-binary warm restart](PD-warm-restart-20261009.md) retain their
separate source and operational scopes.

The loop now applies blocks directly to its staged Scanner. Only a successful
durable batch installs that state. A failed replay may latch the staged Scanner
closed; before flushing, the runtime reconstructs it from the last durable
Scanner and only the successfully applied pending blocks. The rejected block is
excluded. Fetch/decode failures preserve the same successful prefix. A failed
journal write remains poisoned and is not automatically retried.

Archive history, schemas and checkpoint format are unchanged. Current jobs,
signed bytes, unknown outcomes and transport records remain authoritative in
the existing journal. The change does not bypass the fresh finalized account
reconciliation required before a ready view. It introduces no pruning,
reservation reset, provider request or transaction send.

A deterministic regression begins with **4,096 retained blocks** and counts
actual complete Scanner clones using test-only, thread-local instrumentation:

| Batch size | Additional blocks | Measured copies | Prior loop's derived copies |
| ---: | ---: | ---: | ---: |
| 64 | 128 | 3 | 131 |
| 256 | 512 | 3 | 515 |

The three copies are one staging copy and two durable-batch installations.
Prior counts follow from the old per-block loop; they are not a separate timing
measurement. Production still uses the original derived `Clone`; the equivalent
instrumented implementation exists only in tests.

Local validation passed **81 serial challenger library tests**, with 12 ignored.
The two new tests are included in those 81. Three explicitly enabled tests using
the retained SBF challenge archive passed, covering Pending state, finalized
account cuts, batch boundaries, failure prefixes and restart. One separately
enabled shutdown/persistence-failure test passed. These scopes overlap and are
not summed. Clippy with warnings denied, selected-file formatting and diff checks
passed. No new SBF proof or live transaction was generated.

The new failure regression injects fetch, decode and semantic replay errors
before and after a batch boundary. It compares the **complete checkpoint bytes
and every retained block**, then verifies reopening and retrying the same
runtime. Independent agent review found no blocking correctness issue in the
reconstruction, persistence-failure behavior or test instrumentation; this was
source review, not an independent rerun of the suite.

The production behavior change is in `services/challenger/src/runtime.rs`, SHA-256
`b4d1c14094f71f30c701b69621a1a391f28ad96d8238363f0b2d32017423e2e3`.
The [JSON record](PD-replay-batch-copy-20261009.json) pins all four changed source
files, exact retained logs, before-images and review notes. Its serial test log
SHA-256 is `d16d5b0365af51380a9344863c27e1965c08c5a6ea62f133c988d43d80744d80`.
