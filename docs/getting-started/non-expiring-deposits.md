# Adopt non-expiring deposits

This source capability adds an explicit zero-TTL Pool policy. It does not change
the published `public-devnet-20261021-state-v1` Pool, which has a positive TTL.
Existing public deposits keep their original deadlines until withdrawn.

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

Selecting a saved deposit does not renew it. Existing finite deposits can be
withdrawn through their original service and, after confirmed withdrawal,
deposited into the new Pool by an explicit user action. Preserve unresolved
transactions and recovery data throughout. Do not label existing funds as
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
