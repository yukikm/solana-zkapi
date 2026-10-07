# Actual archive RPC failure diagnostics — 2026-10-08 JST

The challenger reported intermittent per-slot archive failures while separate
current-cursor probes succeeded. Those probes could not establish whether the
actual failures were HTTP throttling, transport failures, RPC errors or missing
results. This candidate adds observation only; it does not change pacing, retries,
concurrency, batch bounds or journal behavior.

`ArchiveRpc` now emits a fixed eight-field `archive_rpc_failure` record for an
actual failed call: allowlisted method, static phase, optional numeric HTTP/RPC
codes, timeout boolean, elapsed milliseconds and bounded cooldown seconds. The
method maps to `other` if unrecognized. URL, parameters, headers, body, response ID,
RPC message/data and nested transport errors are never serialized into the record.
The existing error return and shared HTTP 429 cooldown remain unchanged.

The redaction unit test passed. All seven HTTP integration tests passed: five
existing order/cursor/cancellation regressions, one subprocess stderr matrix with
eight failure cases, and its inert helper. The matrix checks exact one-request
counts and omission of synthetic private strings from actual stderr. Initial test
compilation failed because Tokio's process feature was unavailable; the test was
corrected to use existing standard-process and blocking-task support, preserving
the dependency graph and initial failure log.

The Linux challenger SHA256 is
`4c41d3ec99e5e320ee0e4ae886542801141cc0413b1337999610cc217d79dd56`.
The 120-second locked Rust 1.90.0 build used the pinned Amazon Linux 2023 image.
All 179 source inputs and copies remained unchanged, and network-disabled smoke
passed with expected exit 2, resolved libraries and GLIBC at most 2.34. The
[verification inventory](PD-public-runtime-rpc-diagnostics.json) pins the inputs,
logs, binary, previous retained candidate and failure history.

No throughput, host readiness or long-term capacity improvement follows from this
instrumentation. Actual deployment observations will determine the failure cause.
These source/build/fixture checks sent no live RPC, provider, AUTH or transaction
request and changed no funded state, authority, history cursor or budget.
