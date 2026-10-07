# Direct browser demo budget and withdrawal compatibility

The standalone local OpenRouter demo needs a fresh reservation before each new direct AUTH can issue a provider key. The browser sends inference directly to the provider, so the local host cannot honestly enforce a remotely observed inference-operation count. This implementation reserves the full 1,000,000-micro-USDC key cap for each new request UUID and counts that reservation against the existing campaign's money and request limits. An identical AUTH retry consumes no second reservation and grants no inference replay.

## Implementation and API

`scripts/provider_demo_budget.py` extends the original budget reader using the same `budget.lock`, `budget-identity.json` and `budget-state.json`. It cannot initialize a campaign. It validates the unchanged parent plan hash and all historical reservations, then appends a row only for a pinned `openrouter-direct-plain` or `openrouter-direct-sse` template with the exact 1,000,000 cap. It never changes the plan, identity, old rows or reserved maxima.

The host calls:

```sh
python3 scripts/provider_demo_budget.py budget-status \
  --plan /absolute/parent-plan.json --state-dir /absolute/existing-budget

python3 scripts/provider_demo_budget.py reserve-direct-demo \
  --plan /absolute/parent-plan.json --state-dir /absolute/existing-budget \
  --case openrouter-direct-plain --request-id <canonical-v4-uuid> \
  --authorization-sha256 <sha256-of-exact-forwarded-AUTH-bytes>
```

The direct row has kind `explicit_direct_demo`, case ID `demo-auth-<request UUID>`, template case ID, request UUID, exact AUTH SHA-256, full cap and state `reserved_no_automatic_replay`. It has no invented inference operation UUID. New rows return `newly_reserved: true`; an identical request/template/digest returns `false`. Both return `auth_forward_allowed: true` only after a successful file and directory fsync, and `inference_replays_supported: false`. The host must independently validate the request UUID, quote, mode and cap, compute the digest from the exact bytes, and reserve before forwarding AUTH.

A changed digest/template for an existing UUID fails. Request UUIDs cannot collide with existing OpenAI explicit-demo sessions. Concurrent identical calls append one reservation; control-service idempotency still governs their exact AUTH forwarding. A failed/unknown AUTH retains the full reservation. An exact retry re-fsyncs the unchanged state before returning authority, covering a previous uncertain directory fsync. Completed or uncertain reservations never fund a different request, and no refund or automatic inference retry is supported.

The helper also retains the original `reserve` and `reserve-demo` CLI APIs for the fixed OpenAI host. Direct and proxy demos therefore consume one shared campaign without resetting either limit.

## Recovery compatibility

The three immutable native campaign sources remain byte-for-byte unchanged: `provider_acceptance.py`, `provider_acceptance_client.ts` and `i10_devnet_provider.ts`. Their historical source pins are preserved. The frozen native acceptance coordinator deliberately rejects the new row kind; it must not silently omit consumed capacity. New native acceptance runs after direct-demo use require a separately reviewed compatibility update.

Previously funded provider withdrawal remains supported. The launcher now uses the compatible helper for its three budget-status reads. `provider_demo_budget.ts` validates the new rows in the settled/unstarted recovery verifier, including UUID/digest shape, exact template/mode/cap, duplicate-session exclusion and the original total/count arithmetic. SDK wallet settlement, escape and withdrawal authority is unchanged; these rows are accounting input, never financial authorization. The launcher records the added helpers in its execution-source hashes. The fixed OpenAI host's coordinator wiring is handled by the separate host change.

## Validation and limits

[Machine-readable results and source hashes](I10-parity-review-demo-budget-components/results.json) record eight new Python budget tests, twenty-two unchanged legacy Python tests, seventy-five recovery tests and strict launcher/recovery TypeScript checking, all passing. `git diff --check` passed. Tests include concurrent processes, uncertain fsync, exact retry, changed bindings, money/count exhaustion, mixed proxy/direct UUID collisions and malformed rows.

The public ten-row historical ledger was copied into a temporary private directory for testing. Its 2,154,216-micro-USDC total and every original row were preserved; appending one synthetic direct reservation produced 3,154,216 reserved and 6,845,784 remaining. Actual settled and unstarted recovery verifiers accepted these copied historical rows plus either direct template and rejected corrupted variants. No live budget, journal, profile, wallet, provider credential or campaign file was modified, and no network or signing action occurred.

Initial fixture and type-check failures are retained with explanations in the result record. These tests use synthetic recovery proof verification and do not add provider, Phantom, public finality or full I10 acceptance evidence.
