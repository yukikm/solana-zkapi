# ADR-0004: Optional non-expiring deposits

## Decision

A newly initialized Pool may set `TTL=0` to opt into non-expiring deposits.
Its authenticated manifest uses `note_ttl_seconds: "0"`. Both values must
match. The SDK reports this as `depositExpiryPolicy: "none"` only after
authenticating the manifest and verifying the finalized Pool configuration.
Positive TTLs retain their existing finite-expiry behavior.

For a zero-TTL Pool, every new Note uses the canonical `expiry=u64::MAX`.
This is an identity encoding for the explicit no-expiry policy, not an
extremely long configurable lifetime. The Vault rejects `claim_expired` for
these Pools even when the supplied clock equals `u64::MAX`. Clients must not
render the sentinel as a calendar date. An inconsistent finite witness in a
zero-TTL Pool is rejected, not silently rewritten.

The original request circuit checks `request_time <= expiry`; all representable
request timestamps satisfy that condition with this sentinel. The existing
request, withdrawal and tree circuits, proving keys, verifying keys and Note
layout remain unchanged. All other proof, balance, authorization, receipt and
finalized-account checks remain mandatory.

## Motivation and departure from upstream

The pinned Ethereum v2 protocol collects usage charges when a Note closes.
Its expiry claim addresses a user who leaves without settling by allowing the
operator to collect the entire original deposit. This includes unused funds.
That is a policy choice, not a requirement for anonymous prepaid access.

A service offering a reusable prepaid balance can instead accept the risk that
payment remains in escrow until the user withdraws. The zero-TTL policy chooses
that tradeoff. It does not create periodic on-chain settlement or permit the
operator to collect an unproven charge. Providers may still have separate
session and authorization limits.

This is an intentional extension of the pinned upstream state machine. The
vendored upstream sources and their provenance are unchanged.

## Withdrawals and other deadlines

`challenge_seconds` must remain positive. Escape initiation, challenges and
finalization keep the same deadlines and checks. Pending withdrawals cannot
authorize chats. Quote expiry, provider key leases, clearance validity,
transaction blockhashes and payload-buffer expiry are unrelated to Deposit
expiry and remain enforced.

## Existing custody

TTL is immutable after Pool initialization. A positive-TTL Pool and its existing
Notes remain finite. Their expiry is bound into both the tree leaf and private
state; editing a journal cannot extend it. A new SDK package alone does not
remove the existing forfeiture condition.

Adoption therefore requires a compatible Vault deployment and a new zero-TTL
Pool, authenticated manifest/profile, operator services and isolated client
storage. Existing profiles, journals and recovery services must remain
available. Moving funds requires the user's explicit withdrawal and new deposit;
there is no automatic transfer, journal rewrite or implicit custody migration.

See [the adoption procedure](../getting-started/non-expiring-deposits.md).
