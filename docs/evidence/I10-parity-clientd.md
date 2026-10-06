# Clientd model configuration and session handoff

The local client daemon now binds each advertised model to its provider, API
allowlist and manifest-pinned tariff. Switching proxy models, or sending after
the reuse window, can complete the old session and continue the original new
request in one call. These changes address the clientd parity review without
introducing a second financial state machine.

## Implementation

`packages/sdk/src/clientd-models.ts` validates the new per-model configuration
before the native runtime serves requests. Each tariff's canonical hash must be
pinned by the authenticated manifest; its provider, model and pricing basis must
match the explicit mode. Unsupported API/model combinations fail before AUTH,
and `/v1/models` reports the validated IDs and providers. The SDK source tree is
already included in the existing clientd distribution builder.

The legacy `models: string[]` plus top-level tariff file remains supported when
the tariff covers the whole list. One exact proxy model and multiple concrete
direct models sharing a wildcard tariff remain valid. A legacy proxy list with
unrelated IDs now fails startup with a migration error, instead of advertising
models whose quotes fail. Configuration, deployment pins and saved sessions are
not rewritten. The clientd README documents both forms.

`ClientDaemon` retains the original new request ID and bytes while closing an
incompatible or expired session. It proceeds only after the existing
ControlClient verifies receipts and the successor and clears the pending
session. Active responses, unfinished settlement, verification failure,
cancellation and shutdown prevent new admission during that handoff. Duplicate
IDs remain rejected in pending and settled history. No previous inference is
replayed, and no mode fallback was added.

The installed-SBF test previously advertised the unrelated model `fixture`
while loading a native proof fixture tariff for `local-test`. Its generated
local manifest and model list now use that fixture tariff and hash consistently.
This changes only the test fixture, not any public manifest. Actual SBF was not
rerun for this clientd change; the test remains typechecked and ready for the
separate native/SBF acceptance environment.

## Local validation

All commands below passed using Node **24.19.0**. Exact command arguments,
statuses and byte hashes for the saved TAP logs are in
[results.json](I10-parity-clientd-components/results.json).

| Command | Result |
|---|---|
| `node --test --test-reporter=tap packages/sdk/test/clientd.test.ts packages/sdk/test/clientd-models.test.ts` | 29 passed, zero failed/skipped |
| `node node_modules/typescript/bin/tsc --noEmit -p apps/clientd/tsconfig.json` | Passed |
| `npm run typecheck` | Passed, including the updated SBF test source |
| `node --test --test-reporter=tap packages/sdk/test/clientd-models.test.ts packages/sdk/test/clientd.test.ts packages/sdk/test/control.test.ts packages/sdk/test/client.test.ts` | 105 passed including subtests, 77 top-level tests, zero failed/skipped |
| `git diff --check` | Passed |

The focused and broader counts overlap. They are not separate end-to-end pass
counts. Logs: [focused](I10-parity-clientd-components/focused.tap) and
[shared lifecycle regression](I10-parity-clientd-components/regression.tap).

Twelve new tests cover provider/API/tariff selection with real Ed25519 quote
signatures; legacy proxy/direct compatibility; invalid configuration; exact
operation/body preservation across model changes; active streams; close outages,
unfinished settlement and rejected successor verification; abort/shutdown during
close; reuse expiry with concurrent maintenance; and pre-AUTH API rejection.
Lifecycle tests use the real encrypted journal and locks with synthetic
provider/proof/settlement fixtures. Existing Unix socket cancellation tests also
passed.

These results establish local behavior only. No provider request, public
transaction, funded journal migration, deployment or service change was made.
Live multi-model interoperability, streamed billing and public release acceptance
remain separate. Existing historical reports and aggregate source inventories
were preserved.
