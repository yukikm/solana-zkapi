# Provider acceptance integration: preserve the authorizing client

Date: 2026-10-07 JST. This follow-up fixes a coordinator integration defect
identified after the [memory-only provider-key change](I10-parity-review-privacy.md).
It does not add live provider or public devnet acceptance.

## Reproduced finding and correction

**P2 — Direct acceptance authorized with one `ControlClient` and attempted
inference with another.** `authorizeSaved` constructed a fresh
`authorizationClient(signal)` for its bounded request, while inference and close
used the original `o.client`. Once keys became memory-only, the authorizing
instance owned the only usable direct key. The original instance therefore
refused the direct inference, even after successful AUTH. Sharing an encrypted
journal does not transfer an in-memory key. Earlier proxy-only orchestration
fixtures did not expose this integration error.

The helper and `i10_devnet_provider.ts` now use the same existing client for
quote, authorization, inference and settlement. No factory, key transfer or
persistent-key fallback remains. To keep HTTP deadlines without retaining an
expired signal on the instance, `ControlClient.quote`, `submit` and `recover`
accept an optional per-call `AbortSignal`. That signal is combined with the
existing transport timeout and follows only that call's control requests,
initial OA verification, receipt reads and immediate recovery close. A later
inference or explicit close gets its own signal. Client configuration and
transport are never temporarily mutated.

The existing journal commit still completes before AUTH transport. Cancellation
does not race or abandon a durable write. An uncertain authorization retains
the exact proof/body/credentials, and only that authorization is retried.
Inference remains a single durable send. OA verification timeout discards the
key and leaves closing intent durable; a later explicit close can settle it with
a fresh signal. Proxy behavior and the integer budget coordinator are unchanged.

Changed implementation files:

- `packages/sdk/src/control.ts`: per-call quote/submit/recover transport signals.
- `scripts/provider_acceptance_client.ts`: reuse its supplied client.
- `scripts/i10_devnet_provider.ts`: remove the alternate authorization factory.
- `scripts/provider_acceptance_client.test.ts`: direct-mode integration fixtures
  using real `ControlClient`/encrypted journal, real Ed25519 quote signatures,
  synthetic proof/settlement verification and fixture provider transport.
- `packages/sdk/INTERNALS.md`: same-instance and scoped-cancellation contract.

## Verification

[Commands, source hashes and saved-log hashes](I10-parity-review-provider-custody-components/results.json)
identify the separate development and final snapshots.

The new direct OpenRouter and direct OA tests both failed before the fix and
passed afterward. They use the actual SDK authorization and send methods;
no fake client object conceals key ownership. They wait until the successful
AUTH deadline expires during inference, then verify that inference and close
still have live signals. They also verify keyless durable history, one budget
reservation, one inference and no replay.

Additional direct cases cover a transient 503 and a lost AUTH response with
identical saved AUTH/token bytes; uncertain inference followed by one close and
no replay; and an OA verifier stopped by the actual scoped `TimeoutError`,
followed by a successful explicit close without further key issuance. The
verifier test explicitly distinguishes its abort from the watchdog fallback.

Final results:

| Command | Result |
|---|---|
| `target/i08-toolchain/bin/node --test --test-reporter=tap scripts/provider_acceptance_client.test.ts scripts/i10_provider_report.test.ts scripts/i10_devnet_provider_config.test.ts scripts/i10_devnet_provider_recovery.test.ts` | 131 passed, 66 top-level tests, zero failures/skips/cancellations |
| `target/i08-toolchain/bin/node --test --test-reporter=tap packages/sdk/test/control.test.ts packages/sdk/test/clientd.test.ts packages/sdk/test/client.test.ts packages/sdk/test/wallet-emergency-escape.test.ts` | 138 passed, zero failures/skips/cancellations |
| Explicit strict TypeScript check of the helper, coordinator and helper tests | Passed |
| SDK and native runtime TypeScript checks | Passed |
| `git diff --check` | Passed |

The initial broad provider run passed 130 of 131 tests: its 30 ms verifier-test
deadline could expire during initial journal persistence before reaching the
verifier, correctly leaving `send_unknown`. The final test allows 1,000 ms to
reach the deliberately blocked verifier and requires an observed `TimeoutError`;
its 5,000 ms watchdog cannot produce a passing result. An intermediate strict
typecheck exposed a widened fixture provider type; explicitly typing the test
context fixed it. Those logs remain archived. The two subsequent 131-pass
snapshots are retained, with the last including the explicit abort-reason check.

No provider credential, funded journal, campaign identity, deployment pin, saved
report, reservation or budget was changed by this correction. No external
inference or transaction was sent in this work. Existing reserved cases remain
non-replayable; changing the helper does not authorize reinitializing a saved
campaign whose immutable source identity differs. The live coordinator must use
its existing authorized budget and preserve historical identities/results.
