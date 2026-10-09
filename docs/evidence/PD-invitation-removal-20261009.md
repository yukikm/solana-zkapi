# Public API invitation removal — 2026-10-09

At **02:39:47 UTC**, the requested ZKAPI gateway update completed with
`requireInvitation: false`. Anonymous HTTPS `GET /relay-status` subsequently
returned HTTP 200 with `invitation_required: false`, admission enabled and
recovery enabled. This change applies to the ZKAPI API gateway; the independent
`zkchat` application was not edited or republished.

Only the gateway restarted, once, as PID **118529**. Two TypeScript sources and
the single `requireInvitation` configuration field changed. All five other
service process identities and service policies were preserved. The complete
5,835-byte remote receipt was independently retrieved and verified at SHA-256
`5303896b3add98b928e04123b4ed9adfcaf2605fdf36b7478d9b780ac8d100ec`.
The [machine-readable record](PD-invitation-removal-20261009.json) records exact
old/new source hashes, dispatch identity, public observations and test hashes.

The option defaults to `true` for existing gateway configurations. An explicit
`false` accepts new session AUTH without the invitation header, retaining
normal session credentials, quote and proof checks, exact-byte reservations,
budget exhaustion and admission suspension. Older clients may still send their
invitation on AUTH; it is stripped before upstream forwarding. Missing or
mistyped configuration does not silently disable an existing invitation gate.

The complete database hash remains `49c3b138…60f16` and the reservation hash
remains `29be8a5b…337706`: four settled sessions, four full-cap reservations and
all 25 recovery checkpoints. The public budget still reports seven total
reservation slots, four reserved and **three remaining**. No grant was created,
reset or replenished. No new AUTH, inference, wallet transaction, E01 replay or
SDK/native release was performed. Original journals and prior releases remain
unchanged.

All **48 local gateway/relay tests passed**, with zero skips. The new cases cover
explicit invitation-free configuration, credential rejection, new AUTH without
a token, obsolete-header compatibility, exact recovery, changed-byte rejection,
budget exhaustion and suspended admissions. Local fixtures use synthetic proof
bytes and do not establish fresh funded acceptance. Production Node syntax
checks also passed. An intermediate fixture incorrectly expected three budget
guard invocations; the changed-byte recovery rejection also invokes that guard,
so its expectation was corrected to four. The failed run is retained.

The first Python urllib public probes returned `URLError`; separate normal-TLS
curl probes completed. Initial public capability observation returned **HTTP
503 with indexer unavailable**, while control and signer were available. This
does not undo the independently verified invitation setting. Its cause is not
established, and this rollout does not claim continuous availability or provider
credit. A second public observation at **02:42:19 UTC** again returned HTTP 503
with indexer unavailable; both responses are retained in the JSON. No indexer
restart or additional service change was made as part of this API access update.

Without an invitation gate, a public caller can consume finite reservation
capacity even when downstream proof validation rejects its request. The existing
budget remains enforced; this change does not add rate limiting or unlimited
preview funding.

Publication preparation used a clean checkout of the published `89b5010` main
baseline, pinned Node **24.19.0** and npm **11.9.0**. The same 48 gateway tests
passed there. SDK runtime and packaging sources match the existing `.3` release;
only a previously published E2E test fixture differs. Rebuilding the SDK produced
identical bytes for every packaged file, although the archive hash differs. The
original immutable SDK `.3` artifact remains the distribution; no SDK version
bump or replacement package is required for the gateway setting.
