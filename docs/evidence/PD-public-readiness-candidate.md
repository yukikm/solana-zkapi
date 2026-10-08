# Read-only public readiness candidate

This source change adds a credential-free `GET /zkapi/v1/readiness` diagnostic.
It is **not deployed**. The [machine-readable evidence](PD-public-readiness-candidate.json)
records the exact source and local test hashes. PD-01's live unavailable-capability
acceptance remains open.

The control service samples the authenticated finalized indexer cut, the signer's
read-only reconciliation health, and configured provider availability. The gateway
returns finite states for the independently pinned public deployment and provider.
It preserves `stale`, `paused`, `unavailable`, `invalid`, `unreconciled` and
`disabled` distinctions instead of reflecting private error strings. Provider
`enabled` means its adapter, current tariff and database breaker permit use; no
provider API or credit query is made. Both `provider_credit` and
`operator_admission` are always `not_checked`. HTTP 200 is not an AUTH guarantee.

Indexer availability requires the trusted genesis, exact random RPC response
nonce, finalized source blockhash, Pool configuration, and the derived TreeState's
owner/version/bump and exact root/sequence/next-note count. A newer finalized
account cut also requires its block header. Clock identity and time bind the
observation, with a 120-second freshness limit. Signer health uses only the health
request and privately matches its configured digest; neither that digest nor the
socket path is returned. The existing `/relay-status` remains explicitly limited
to relay configuration.

Concurrent callers share one control probe. Completed observations are cached for
five seconds. The indexer probe has a 25-second total deadline and at most four
read-only RPC calls; signer and provider-database waits have separate two-second
limits. The gateway has a 28-second limit. Responses are bounded to 64 KiB for
RPC/indexer JSON, less than 4 KiB for the signer line and 8 KiB for the control
projection. There are no automatic retries, signatures, AUTHs, inference calls,
transactions, provider credentials or ledger writes in this diagnostic. The
signer client deadline does not impose a new execution deadline on the signer's
existing server-side read-only audit.

Focused verification passed:

- Seven Rust tests cover finalized identities and stale/future clocks, TreeState
  substitutions, exact nonce/method envelopes, malformed/oversized replies,
  unavailable and unreconciled signer health, disabled provider policy,
  concurrent/cancelled waiters and an expired fallback after a worker panic.
  The clock fixture was then made deterministic by reusing its captured time;
  that one test passed again, with production code unchanged.
- The final canonical route passed 35 gateway/host tests, including exact GET,
  CORS, credential/body/query rejection before callback execution and unchanged
  relay-status scope. Four unchanged projection tests separately cover finite
  states, pinned provider filtering, expiry, identity, redaction and no retries.
- Rust 1.90 formatting and offline Clippy with warnings denied passed. The new
  TypeScript module and its tests passed strict type checking with Node 24.19.0.

The first sandbox runs were unable to bind local TCP/Unix fixture sockets. Their
failures are retained. Root reran the same tests with normal local socket access;
no checks were skipped or relaxed. An earlier 39-test route snapshot is retained
separately from the final canonical-route run; counts overlap.

If systemd stops control as a dependency of an unavailable signer, the gateway
can only report `control: unavailable` and the other components as `not_checked`.
It does not invent a signer-only cause. A cached observation can also become
outdated before a request: invitation, capacity, provider credit and financial
admission are still checked by their existing request paths. Public fault
injection and deployed endpoint verification require a separate later cut after
the current native funds lifecycle; no client release, profile or live service
was modified by this candidate.
