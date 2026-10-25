# Adopt non-expiring deposits

This source capability adds an explicit zero-TTL Pool policy. It does not change
the published `public-devnet-20261021-state-v1` Pool, which has a positive TTL.
Existing finite deposits keep their original deadlines. The fresh prelaunch
Pool does not transfer earlier test balances or rewrite their journals.

## Public Devnet identity

The fresh deployment is `public-devnet-20261025-nonexpiry-v1`. Its finalized
Pool was verified with `note_ttl_seconds: "0"` and `challenge_seconds: "1800"`.
The matching operator services were activated on 2026-10-25 and passed backend
readiness checks. Verify current readiness and the finalized configuration
before depositing; this does not establish funded client acceptance.

| Pin | Value |
|---|---|
| Program | `GnVHYANsc3zsYQfU6EBuFbT8v8tHZtd91baGNKJWFkMZ` |
| Pool | `DfzSmjTetKSNwAcGPM8Th3k2orQtxT1vZVheWr1YttTX` |
| Vault authority | `FfwiU41LnoWrqYyaKExxb9dnZ3gGoUU2ygwqwv9GyFdz` |
| Vault USDC token account | `MCUhddQGQEGJUzvUrptQVZ79NqTAtPAmpemRemieo8D` |
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Main profile | `https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261025-nonexpiry-v1/profile.json` |
| Main profile SHA-256 | `6a050132ad02df94996521d37337faf13d9a77c979e47fac11742ac65538121a` |
| Expanded model profile | `https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261025-nonexpiry-v1/profile-models.json` |
| Expanded model profile SHA-256 | `c4c74bc9c980c2e2549ea513aa1792b7e94cc00442f1954573cd3791f6843706` |

The Vault token account is deterministically derived from the verified program,
Pool and mint by the SDK's `vaultAccounts` helper. Sending tokens directly to it
does not create a Note. Use SDK `.20` for the deposit lifecycle; native installers
remain `.15` and are not updated by this SDK publication.

## Recover the same Pool in another browser

Save the recovery file separately during enrollment. Further deposits, balance
changes, the selected deposit and pending financial operations continue to be
saved to the encrypted backup; a previously exported file restores the latest
saved state. Stop the old browser's tabs, connect the same wallet in the new
browser, and explicitly restore using the file. The hosted backup service must
be available. The restored browser becomes the owner; the old owner is refused.
This does not recover separately stored chat history.

Keep a stable application storage name and first-note ID for this Pool across
SDK upgrades. zkChat uses `zkchat-sdk-public-devnet-20261025-nonexpiry-v1` and
`zkchat-note-sdk-public-devnet-20261025-nonexpiry-v1`. Deployment ID, Pool, wallet
and installed profile pin must continue to match. Changing any of these is not
an ordinary SDK update and must not silently replace the existing custody
binding. Recovery files for another Pool are rejected.

Hosted synthetic-record acceptance on 2026-10-25 verified this A-to-B flow in
two isolated Chromium contexts and in separate Chromium-to-Firefox and
Chromium-to-WebKit runs. Each restored three MAX-u64 Notes, including deposits
and balance changes made after file export, selected-deposit state and pending
operations. Wrong files were rejected, the old owner was fenced, and the new
browser reopened the state after reload. These tests used the actual encrypted
recovery endpoint and final new-Pool identity, without funds, wallet transactions
or provider inference. WebKit engine coverage does not establish Safari app or
Phantom wallet compatibility.

## Prepare and verify

1. Build and verify the updated Vault, SDK, native client and operator services.
   Preserve the existing immutable release assets and funded profiles.
2. Verify the zero-TTL regression cases: canonical max-expiry deposits, rejected
   expiry claims, real request/withdrawal proof compatibility, legacy positive-TTL
   behavior and unchanged escape challenge/finalization timing.
3. Prepare a fresh Pool with `ttl=0`, a positive `challenge_seconds`, the existing
   amount/cap rules and explicitly selected authorities. This is not a change to
   an initialized Pool's TTL.
4. Prepare a separately authenticated deployment manifest with
   `note_ttl_seconds: "0"`, matching actual Pool timing and independently checked
   program/build artifacts. Prepare the matching indexer, control, signer and
   challenger configuration. Do not replace files or journals for the old Pool.
   If enabling automatic unknown-cost recovery, the fresh database needs its
   own explicitly approved future policy cutoff; do not copy an old Pool's
   timestamp. Same-Pool restarts retain the exact registered cutoff. See
   [automatic direct recovery](direct-auto-recovery.md#unknown-result-policy).
5. Publish a new profile identity only after deployment and finalized checks.
   Use a new client storage namespace and explicitly select that deployment.

Preparation and local tests do not authorize a public transaction, program
upgrade, host change or user funds transfer. Review the concrete deployment
artifacts and obtain the required operator approval before activation.

## User experience

The SDK's `depositExpiryPolicy` is available before funding. The app may say
"Unused funds do not expire" only for `none`; the SDK exposes `expiry: null`
in that case. A legacy or positive-TTL deposit must retain its expiry warning.
Show the finite-expiry terms before the user's wallet approval as well.

Selecting a saved deposit does not renew it. Where an original finite-Pool
service remains available, funds can be explicitly withdrawn and then deposited
into the new Pool after confirmation. Retired prelaunch services do not imply a
recovery guarantee. Preserve unresolved transactions and recovery data throughout. Do not label existing funds as
non-expiring or automatically create replacement transactions.

Chat still requires sufficient authorization balance and resolved payment
state. Non-expiring does not mean free requests, service availability guarantees,
or removal of the withdrawal waiting period.

## Operational tradeoff

The operator receives usage charges when the Note closes. With zero TTL it
cannot sweep an abandoned Note's principal. The operator accepts that settlement
can be deferred indefinitely. Any future periodic settlement design requires
separate proofs and accounting changes; do not infer authority from elapsed time.

See [ADR-0004](../adr/0004-non-expiring-deposits.md) for the protocol decision.
