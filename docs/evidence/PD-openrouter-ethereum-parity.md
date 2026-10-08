# Direct OpenRouter settlement: Ethereum parity

The user selected **behavioral parity with Ethereum zkAPI**, replacing the
stronger final-invoice/completeness gate previously added to the core preview.
The reviewed upstream revision is
[`045b444ea1b52538d1b40273c7cb6ed09468a052`](https://github.com/ethereum/zkapi/tree/045b444ea1b52538d1b40273c7cb6ed09468a052).
Seven retained anonymous source downloads match the vendored files and Git
objects exactly; the [comparison record](PD-openrouter-ethereum-parity.json)
retains their hashes and the remote-ref observation.

For directly managed OpenRouter keys, upstream:

1. Confirms disable and waits the configured grace.
2. Captures one valid management `usage + byok_usage` observation.
3. Persists that amount before deleting the key.
4. Confirms deletion before producing the capped immutable settlement.

Its [retirement implementation](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/crates/zkapi-serverd/src/processor_v2.rs#L1010-L1147)
reuses persisted usage after a deletion failure and never reprices a finalized
lease. Missing or invalid usage is an error, not zero. Upstream's CLI defaults
are **5 seconds grace and 2 seconds settlement polling**; these are operator
settings, not measured accounting-finality guarantees.

Upstream [explicitly assigns accounting delay to an operator assumption](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/docs/api-spec.md#L39-L42)
and [does not claim an authoritative final receipt from this aggregate API](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/docs/note-bound-commitments.md#L58-L62).
The Solana contract therefore attests the **captured management USD**, with exact
decimal conversion and existing cap/receipt checks. Delayed or unobserved cost
remains the operator's risk and cannot increase an already signed customer charge.
A separate invoice-completeness service is not a core-preview requirement. OA's
issuer-finalized receipt path and proxy rules remain distinct.

The Solana successor is **locally validated and installed**. It removes
the additional second-equal-sample wait while retaining legacy checkpoints, durable
captured usage, deletion recovery and immutable settlement. The focused local
checks passed **10 configuration tests, 15 direct-adapter tests and one signed
HTTP retirement/restart test**, with zero skips in those executed scopes. They
cover zero/nonzero capture, grace, historical counter regression and recovery
after a lost deletion response without rereading usage. Production source stayed
unchanged across the successful runs. The initial disk-space, sandbox PostgreSQL
and test-only compilation failures remain recorded. An isolated offline Linux
build and no-configuration ABI smoke also passed for both `controld` and
`dispatcherd`, with all 180 input files unchanged. Their binary hashes are
retained in the comparison record. At 17:18:06 UTC, separate read-only completion
`e817f335-a75e-4402-bb50-c994ea7ac98a` confirmed both binaries and the two reviewed
configuration replacements (five-second grace), reporting receipt SHA
`a161ad3985841c6850e74e3b63dd8ea44e5f45b23318d939f9eb299925c3d319`. The original
installer had already replaced the files and restarted control, then failed its
post-start accepting-count guard; that failure remains preserved. Completion
revalidated the exact files, other service identities, full four-session database
and reservations without another service or configuration action. Gateway
remained stopped, and no public readiness or new paid-provider acceptance follows.
The receipt hash is authenticated by successful SSM output; full native receipt
bytes were not independently downloaded at this cut.

The [N-02/N-03 discrepancy](PD-openrouter-management-usage-limit.md) remains:
signed management-counter charges are zero, while the client retained
**USD 0.0008349** of response `usage.cost`. Those values and all old signed
receipts remain unchanged. This parity selection does not establish invoice
accuracy, resolve the provider-internal discrepancy or close broader G3/I10.
No historical inference replay, customer retrocharge, new paid matrix, UI work
or pristine-OS requirement is introduced.
