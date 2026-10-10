# Solana zkAPI requirements and acceptance

These stable requirement IDs define the full protocol and product scope. They
are useful when reviewing a change or selecting regression coverage; they are
not a task sequence or a record of completed tests. See
[support status](../status.md) for verified release scope and remaining
limits, and [operations](operations.md#6-release-gate) for production gates.

Detailed behavior is defined by the [architecture overview](../architecture/overview.md),
[protocol](protocol-solana.md), [tree transition](tree-transition.md),
[API and accounting](api-proxy.md), and [operations](operations.md) specifications.
Deployment-specific defaults and compatibility claims must come from the
authenticated profile and the current release guides.

## Required capabilities

| ID | Capability | Required behavior |
|---|---|---|
| P01 | Private notes | Generate and retain secrets, commitments, blinding and anchors on the client. |
| P02 | USDC deposits | Transfer the fixed mint to PDA-controlled custody and register an integer micro-USDC deposit and leaf. |
| P03 | Active tree | Maintain the specified 32-level tree, leaf/node hashes, zero leaf and ordered insertion, removal and restoration. |
| P04 | Local proving | Generate actual Groth16 proofs in native Rust and browser WASM. |
| P05 | Genesis and signed states | Preserve initial `B=D, τ=1` and verify every signed successor state. |
| P06 | Note-bound commitment | Preserve `E=B·G+r·H+L·J` and rerandomization. |
| P07 | Private authorization | Bind the request identity, prompt-free payload, quote and cap to the proof. |
| P08 | Double-spend protection | Reserve nullifiers durably, recover identical authorizations and reject conflicting authorizations. |
| P09 | USDC quotes | Freeze mint, decimals, tariff version, cap and expiry, including the USD-to-USDC pricing policy. |
| P10 | Expired-quote recovery | Distinguish an unaccepted expired quote from recovery of an already accepted authorization. |
| P11 | OA-org direct adapter | Pin the issuer/verifier contract, validate issuance and usage evidence and settle the lease. |
| P12 | OpenRouter direct adapter | Persist issuance, disable, accounting grace, captured management usage and deletion under the specified policy. |
| P13 | Direct inference | Send prompts and responses to the provider without routing them through the payment service. |
| P14 | Usage settlement | Deduct a charge within the cap and return exactly one signed successor state. |
| P15 | Lease recovery | Recover response loss, uncertain issuance, confirmed non-issuance and interrupted settlement. |
| P16 | Mutual withdrawal | Verify clearance and withdrawal proof, consume the nullifier and pay the user `B` and treasury `D−B`. |
| P17 | Escape initiation | Immediately remove the leaf, consume the nullifier and record the pending withdrawal and deadline. |
| P18 | Stale-escape challenge | Restore the leaf using the historical request proof and the current zero path. |
| P19 | Escape finalization | After the challenge window, pay the saved destination and balance exactly once. |
| P20 | Expiry claim | Send an expired Active note's entire deposit to the treasury; Pending notes are excluded. |
| P21 | Administration | Support treasury changes and pause/unpause with the specified authority and instruction restrictions. |
| P22 | Indexer API | Provide verified roots, snapshots, next note IDs, paths, zero paths and synchronization state. |
| P23 | Browser SDK | Support proof workers, wallet signing, deposits/withdrawals, durable journals and state subscriptions. |
| P24 | Native CLI and API | Provide configuration/startup, models, Chat Completions, Responses, Messages, streaming and wallet operations. |
| P25 | Direct-key reuse | Support configured 1–300-second reuse windows; zero means close after each request. Honor the profile and client defaults, persist configuration and settle when reuse ends. See [session reuse](../sdk/api.md#direct-session-reuse). |
| P26 | Local access control | Bind to loopback, validate Host/Origin, separate wallet administration credentials and redact secrets. |
| P27 | Tor and SOCKS5 | Use remote DNS and fail closed, with consistent routes across the daemon, companion and network clients. |
| P28 | Environment separation | Separate manifests, keys, journals and USDC mints; shared test passwords are test-only. |
| P29 | Recoverable challenger | Persist scan checkpoints, evidence and transaction attempts; verify finality and monitor deadlines. |
| P30 | Distribution and operations | Pin artifacts and provide native/container distribution, configuration, backup/restore and monitoring. |
| P31 | Operational dashboard | Expose restricted summary/recent/event views without secrets or inference bodies. |
| P32 | Proxy authorization | Bind scoped proxy credentials to the proof and recover the same operation idempotently. |
| P33 | Provider adapters | Support OpenAI Chat Completions/Responses, Anthropic Messages and OpenRouter Chat within the declared subset. |
| P34 | Proxy budget and accounting | Reserve concurrent operations within the maximum budget and settle using integer arithmetic. |
| P35 | Proxy fault recovery | Handle streaming, disconnects and unknown usage without duplicate inference. |
| P36 | Tariffs, compatibility and privacy | Publish fixed tariffs and supported APIs, and disclose the proxy operator's visibility of content. |

Provider credentials and account capabilities are external prerequisites. An
unavailable route remains unverified; a successful fixture is not live-provider
acceptance. Text, client-executed tools and streaming are in scope where
advertised. Unsupported modalities, hosted tools and persisted provider
conversations must be rejected before dispatch.

## Acceptance scenarios

| ID | Area | Required coverage |
|---|---|---|
| T01 | Cryptography | Verify the same real proofs natively and in SVM. Reject changes to every public input, proof coordinates, verification key, A-point sign and G2 coefficient order. |
| T02 | Bindings | A one-byte change in cluster/program/pool/mint/token program/destination changes its binding. Reject changed quote, mode and credentials. |
| T03 | Tree | Cover all 11 transition inputs, the same 32-level path, zero insertion, removal/restoration, maximum ID `2^32−1`, `TreeFull` at counter `2^32`, wrong roots/paths and expiry day boundaries. |
| T04 | Tokens | Reject wrong mint, Token-2022, wrong ATA/authority, frozen accounts, insufficient balance and overflow. Transfer failures roll back funds, root and status together. |
| T05 | Exits | Cover mutual close, escape, challenge, finalize, expiry and pause, including deadline equality, historical roots and retained nullifier tombstones. |
| T06 | Transactions | Verify layout-2 wire and the 1,232-byte v0 transaction limit. Crash at every buffer stage. Reject mutation after sealing, old signatures after same-PDA recreation with a different digest, third-party execution and replay. Cover rent return and blockhash recovery; verify each additional advertised transport separately. |
| T07 | Authorization | One hundred concurrent requests for the same nullifier create one reservation. Identical retries recover the same result; different bodies fail. Race AUTH against CLEARANCE. |
| T08 | Quotes | Reject unaccepted expired quotes; recover accepted authorizations after expiry. Reject forged signatures, unknown fields, duplicate JSON keys and floating-point financial amounts. |
| T09 | Proxy cap | Four concurrent reservations remain within the cap; a fifth is limited. Absorb usage overruns as operator losses without double-counting cache usage. Test expiry equality, expiry during row-lock waits and atomic admission versus close. |
| T10 | Rounding | Cover zero, one nano, 999/1,000/1,001 nano, rational item sums rounded once to nano, multiple operations, exact direct-USD conversion, zero denominators, overflow and near-maximum values. Round nano to micro once per session. |
| T11 | Proxy faults | Crash before/after send, during streams, after usage retrieval and around database commit. Prevent duplicate dispatch and free cancellation on disconnect. After owner termination and waiver, reject a resumed old owner's send. Hold signatures when fencing is unproven and never reprice a waived charge. |
| T12 | Direct faults | Recover lost issuance responses, delayed usage and unknown disable/delete outcomes. Drain late issuance after 202/disconnect. Close missing-key sessions without redelivering plaintext keys. Zero usage produces one successor state. |
| T13 | Signer | Crash after `SIGN_PENDING`, after signing and after persistence. Never sign a different charge or anchor for the same request. |
| T14 | Chain races | Race escape against authorization, key delivery and proxy execution; delay one RPC; recover through challenge; reject authorization after expiry claim. |
| T15 | Privacy | Operator logs, databases, traces and backups contain no wallet seed, prompt/response body, raw token or plaintext provider key. Reject prompts in direct authorization. |
| T16 | Compatibility | Verify supported text, client tool calls, SSE, errors and usage. Reject unsupported modalities, hosted tools and persisted Responses before sending. |
| T17 | Client | Exercise restarts, concurrent tabs, journal mismatch, wallet rejection, WASM failure and encrypted backup restoration without advancing a note twice. |
| T18 | Operations | Stop and fence primary/writer/dispatcher; restore backups; reconcile snapshots and full replay including missing logs and buffer close/reuse; compare signer journals; trigger challenger delay alerts. |
| T19 | Receipts | Retrieve signed receipts, recompute integer amounts and compare actual provider evidence. Distinguish OA evidence, OpenRouter captured management usage and proxy measurements. |
| T20 | Release | Reject altered artifacts, PK/VK pin mismatches, mixed deployment environments, missing multisig/receipt keys and a Devnet mint in a mainnet profile. |

The [tree-transition specification](tree-transition.md) adds TT01–TT08 for
proof/state binding and tree-specific acceptance. Compact deposits also follow
[ADR-0003](../adr/0003-single-transaction-deposit.md) and the
[deposit design](../architecture/single-signature-deposit.md).

## Verification boundaries

Select tests for the changed behavior and preserve their prerequisites. Local
state-machine fixtures, real proofs, SBF execution, PostgreSQL/process tests,
browser/wallet tests and live-provider tests establish different facts. An
offline schema/link check does not execute these scenarios.

Use [Contributing](../../CONTRIBUTING.md) for current commands and
[verification records](../development/verification.md) for report handling. Results should
identify the source, dependencies, artifacts, tested environment, failures and
unverified paths. Preserve historical results in Git history or local ignored
reports without treating them as evidence that current source was rerun.
