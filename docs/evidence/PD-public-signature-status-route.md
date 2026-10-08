# Public signature-status routing correction

At **2026-10-08 15:52 UTC**, a read-only check found that the public gateway returned HTTP429 for `getSignatureStatuses`, while `getTransaction` returned the finalized deposit receipt at slot **508866751**. The same signature returned finalized/no error through the configured history RPC directly. A separate probe from the operator host confirmed that endpoint's Devnet genesis and finalized status at **15:56 UTC**.

The gateway now routes both methods through its **existing explicit history RPC**. The single-condition change retains the fresh Devnet genesis check, strict request validation, error redaction, and refusal to fall back or retry another endpoint. The installed SDK **0.2.0-devnet.3**, journal and transaction bytes were unchanged; no transaction resend was added.

| Source | SHA-256 |
|---|---|
| Previous gateway host | `e070011e3cb5b569307de049403e73151ef9c047e91777753452a061d1c188ff` |
| Corrected gateway host, 44,700 bytes | `329c0dc8df7dee9ea7d03522e822e59f6536d26b63e1a3bc0b2fcaea63321cb5` |

The targeted host suite passed **19/19 tests, zero skips**, in 1.588 seconds. It covers both methods, genesis checks and target-error redaction without fallback. The initial sandbox `listen EPERM` failure is retained separately.

The guarded rollout completed successfully at **16:07:54 UTC**. Its 49,645-byte
host receipt was independently fetched and matched SHA
`44ba0adb03d2e2881bf7da3473f0cece61d56a73148811f94fa83cdd0a4ce942`. It changed only this source and restarted gateway once. Configuration/admission, the other five processes, full four-session database bytes, reservation bytes and existing authority locks were checked unchanged. The original source before-image and rollout records are retained. No AUTH, inference or wallet transaction was sent by the rollout.

The subsequent same-journal SDK observation at **16:10:14 UTC still failed**
with the redacted `client_request_failed` result. A separate diagnostic using the
same released `SolanaWalletChain.snapshot` stopped on its first public
`/zkapi/v1/tree/root` GET with **HTTP503** at **16:16:47 UTC**. It made one read,
with no AUTH, transaction send or journal access. This isolates that diagnostic's
snapshot-read failure; it does not prove the cause of the earlier generic error.

The retained primary RPC error body is exactly the 17-byte `max usage reached`
response, SHA `53aa2db9c4c33354ebc05ab7a1f79d512ab17cc2dead68eaa2fc4bfcdebf3536`.
At **16:27:37 UTC**, a separate read-only host cut joined the current snapshot
blocker to the same configured primary RPC: writer `getGenesisHash` and indexer
`getSlot` were repeatedly receiving HTTP429, while the local root returned503.
The writer reported not-ready, tail508866844 and lag2,386 seconds; no pending,
emergency, unknown-signature or failed-proof work was reported. The indexer
reported `source_halted: false`. All six process identities and configurations
were unchanged. The probe issued no new upstream RPC and changed no service.

The saved `max usage reached` body and same-endpoint configuration support an
upstream usage-limit rejection, but no account-plan/reset schedule is established.
The native deposit is finalized on chain while its saved SDK operation remains
unconfirmed. The earlier generic advance error lacks an exact call trace, and
the browser failure's cause remains unproven.

This report records the diagnosed routing defect and successful guarded
installation, **not successful SDK deposit confirmation or E01 completion**.
The [receipt index](PD-public-signature-status-route.json) preserves every outcome.

The separate [provider-cost discrepancy](PD-openrouter-management-usage-limit.md), core acceptance requirements and deferred demo UI remain unchanged. No funded browser or full I10/G1–G4 claim follows.
