# Independent review of volatile direct-key custody

Date: 2026-10-07 JST. Reviewed the memory-only key correction after the initial
[native/protocol review](I10-parity-review-protocol.md). No additional actionable
finding was identified in this scope, and no implementation source was changed
by this follow-up review.

The inspected implementation binds cached keys to a local note ID, exact saved
AUTH bytes and request UUID (`control.ts`, `record`/`save`). A read removes any
legacy durable `providerKey` before considering the current instance's cache.
Only an active, non-closing session without an unresolved emergency escape can
receive that in-memory key. Different notes cannot inherit one another's cache
entry. Changes to the saved authorization invalidate the matching entry.

`save` passes a cloned, keyless value to the journal CAS and retains a key only
after a successful commit. A failed write forgets that note's key. The operation
send path still saves its exact uncertain intent before inference and returns
the original in-memory key only for that admitted dispatch. A fresh client has
no cache, so the existing recovery path closes the same session rather than
reissuing or reviving a persisted key. Same-process OA reuse still authenticates
the key/evidence/expiry/pin binding. Close and settlement remove usable cache
entries; disposal clears keys and remains forbidden while an application action
is busy.

Emergency escape archives now omit legacy provider keys while preserving exact
AUTH and inference evidence. A current cache cannot authorize through an
unresolved emergency escape or a restored session in `closing` phase. Historical
archives remain readable and are not silently migrated. These paths reuse the
existing encrypted journal and financial state machines.

`clearEphemeralKeys()` is expressly local forgetting, not provider revocation or
cancellation of an already admitted dispatch. Public application disposal's busy
guard prevents disposal while its request is in progress. Encryption, JavaScript
memory and garbage collection do not establish attested memory erasure.

## Independent local checks

[Commands, log hashes and before/after source hashes](I10-parity-review-protocol-custody-components/results.json)
are archived separately from the prior 118-test snapshot. All eight reviewed
source/test inputs were unchanged during this run.

- Selected direct/volatile/OA/emergency/disposal/key/restart tests across
  `control.test.ts`, `clientd.test.ts`, `client.test.ts` and
  `wallet-emergency-escape.test.ts`: **72 passed**, zero failures, skips or
  cancellations (35 top-level tests). The name filter intentionally excludes
  unrelated cases; this is not a full SDK run.
- Native runtime TypeScript check: passed.
- `go test -count=1 -race ./...` in `apps/clientd`: all three packages passed,
  with Go test result caching disabled.
- `git diff --check`: passed.

The direct-path tests exercise actual shared `ControlClient` and `ClientDaemon`
code, encrypted storage, same-instance use, lost responses, restart-close,
failed key-delivery persistence and OA verification binding, with synthetic
provider/proof/settlement responses. Cross-note cache separation was additionally
reviewed in source; no new adversarial multi-note test was introduced. No external
provider request, public-chain transaction, credential access, journal migration,
deployment or budget mutation occurred in this review.
