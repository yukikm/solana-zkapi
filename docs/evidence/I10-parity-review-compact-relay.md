# Compact deposit browser relay review

Reviewed 2026-10-07 JST against the combined Ethereum-parity working tree.

## Corrected finding

**P1: The live wallet host rejected the SDK's compact deposit transaction.**
`WalletClient.beginDeposit` selects the schema-2 inline plan when an authenticated
manifest advertises `v0_inline_deposit_v1` and the independent build policy pins
that capability. The live wallet routes its signed transaction through the
loopback host, whose allowlist still excluded `deposit_compact_v1`. A fresh
compact-capable profile could therefore prepare and sign its one-transaction
deposit but receive HTTP 400 before RPC submission.

The [red reproduction](I10-parity-review-compact-relay-components/red.log) uses
`buildInlineDepositPlan`, `compileV0` and an actual Ed25519 payer signature.
Its 1,007-byte transaction was rejected before the fix. The host now permits
this instruction only with an SDK-authenticated compact-capable manifest,
the independent build capability pin, the canonical 19-account shape, the
configured pool in account position zero and the shared strict compact codec.
The codec checks exact argument length, canonical field encodings and positive
amount, and reconstructs implicit public inputs using the pinned Vault binding.
The SDK and Vault retain responsibility for proof and account-state verification.

Buffer-only manifests and caller-supplied lookalikes remain unsupported for this
instruction. All existing devnet genesis, exact-signature, v0/no-ALT, program,
one-Vault-instruction, wire-size, origin and fee-ceiling guards remain in place.
The relay forwards the identical signed bytes with preflight enabled and
`maxRetries: 0`; it never signs or retries a transaction.

## Validation

The [red/green command record](I10-parity-review-compact-relay-components/results.json)
contains command lines, source and log hashes. An initial test syntax error is
preserved separately; the red regression is the subsequent actual HTTP 400
failure, not that syntax error.

| Check | Result |
| --- | --- |
| Focused compact relay red/green | HTTP 400 before fix; 1 test passed after fix |
| All wallet UI suites, including two isolated actual Chrome fixture scenarios | 73 passed, zero failures/skips |
| Strict wallet UI TypeScript check | Passed |
| SDK compact deposit, trust and transport suites | 63 passed, zero failures/skips |
| Fresh standalone browser/worker build | Passed |
| Actual Chrome 154.0.8037.98 standalone scenario | 1 passed, zero failures/skips |
| `git diff --check` | Passed |

All 118 recorded source inputs were unchanged during this run.
The compact test rejects short/long arguments, zero amount, noncanonical fields,
incorrect account count/pool position, missing signature, foreign origin, wrong
genesis, unknown/excessive fees, a buffer-only manifest, an unauthenticated
manifest clone and disabled financial sends. It also proves that a compact
manifest without an independent build-capability pin cannot verify.

The synthetic devnet manifest is independently hash-pinned within the test.
Its tree fixture is adapted to the synthetic binding solely to exercise transport;
it is not claimed to contain a valid proof for that deployment. RPC, chain,
provider and wallet ports are synthetic. These checks did not submit a public
transaction, use Phantom, spend provider budget, change deployment pins or alter
funded journals. They establish the corrected relay behavior, not public compact
deposit or latest standalone live-provider acceptance. Historical actual
fixed-prompt Chrome/Phantom success remains preserved in
[SDK support status](../sdk/status.md).
