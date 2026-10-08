# Public admission continuation and unfunded deposit failure

At 06:20 UTC on 2026-10-08, the explicitly reviewed continuation enabled new admissions while preserving the original failed attempt, consumed cut, authority and zero-reservation grant. A subsequent native deposit-preparation attempt failed before any saved wallet operation or funding. This checkpoint does **not** complete N-01 or any funded acceptance case. Exact retained record digests are in the [JSON report](PD-public-admission-recovery.json).

## Preserved failure and recovery

The original v7 transition stopped the gateway at 05:37 UTC, then failed its effective systemd policy comparison before changing configuration. The diagnostic identified managed inverse `Before` edges disappearing when the stopped gateway unit was unloaded. The v8 operational comparison accounts for those derived edges while retaining forward dependency, unit source and isolation-policy checks.

An explicit suspended-gateway restore issued one start at 05:55 UTC but recorded `URLError` during its immediate read. That failed result remains unchanged; a listener-readiness race is a hypothesis, not a proven cause. A separate read-only observation verified the already-running gateway, unchanged admission-disabled configuration, recovery availability, original records, five other service processes, zero reservations and zero financial database rows. It did not repeat the start or mark the earlier restore successful.

The later continuation used a new exclusive operation identity and retained the original cut and markers. It joined a fresh ten-check installed-SDK preflight and explicit approved review, rechecked freshness before the atomic configuration replacement, and changed only `allowNewAdmissions`. Its receipt records one gateway stop, one gateway start, eight bounded local status reads, unchanged five other processes, zero financial actions and no automatic transition retry. The completed transition digest is `5d3a1eb436eeb97896d69be226899d9dfe703d52555930dccc3e119f431fab85`.

The exact gateway configuration changed from `02ca9c4b4ba6bec06b682570b13490c8337630d7b1e50150a75d3e3e2326f5cb` to `cd8bd41e1d7c06baa82ea96a430953c1feacc63d05654fe611a080463c3fcb9c`. The grant retained zero reservations and state digest `9e72b378b53cbd7dd474c7c14eb340a564f3f88120283acef2a3be6cdaaf47fe`; no original capacity was transferred or reclaimed.

At 06:20:46 UTC, one anonymous public HTTPS status GET returned HTTP 200 with admission and recovery enabled. TLS verification and redirect refusal remained enabled. The preceding Python certificate-store failure is preserved separately. The public response explicitly describes configuration only and says readiness is not checked; it does not establish signer, credit or funded-operation readiness.

## Deposit preparation remains incomplete

At 06:22:47 UTC, the stock installed native client attempted to prepare a 5,000,000-micro-USDC deposit and returned `client_request_failed`. Saved status remained unfunded with balance zero, no journal head, no wallet operation, no unresolved operation and no recovery requirement. No advance, transaction submission, AUTH or provider inference followed.

Two read-only GETs at 06:32 UTC reproduced HTTP 400 for `/zkapi/v1/tree/notes/0/zero-path`, both directly through the public gateway and through unchanged stock native egress, with identical response hashes. The installed SDK calls `chain.snapshot()` before `prover.deposit()` and `journal.create()`; the initial snapshot first reads the root and then this next-note zero path. The rejected route is therefore a concrete blocking condition before proof preparation and journal creation. The generic original error alone does not establish any additional internal cause.

A route correction, new deposit attempt and funded lifecycle results require separate evidence. This record neither updates immutable SDK/native artifacts nor closes funded browser, native, OpenClaw, provider, backup/restart or withdrawal acceptance. The [earlier read-only readiness checkpoint](PD-public-runtime-origin-followup.md) and [detached authority initialization](PD-detached-budget-initialization.md) retain their separate scopes.
