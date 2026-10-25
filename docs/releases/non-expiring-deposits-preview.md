# Non-expiring deposits preview

[SDK `.20`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.20)
was published as an immutable prerelease on 2026-10-25 from commit
`813032cd9070a049c97a81eaa1ca26562416460f`. All seven release asset downloads
matched the reviewed bytes and passed release/asset attestation verification.
The SDK archive SHA-256 is
`58538cd0e8a566c6b094c1f523e9275a68c640b14f239f2a6ce281728d728e8c`.

SDK `0.2.0-devnet.20` supports an explicit non-expiring deposit policy for a
new Pool initialized with `ttl=0`. The matching Vault refuses expiry claims,
and the SDK reports `depositExpiryPolicy: "none"` only after authenticating
the manifest and verifying the finalized Pool configuration. Positive-TTL
Pools retain their original policy. Withdrawal challenge periods are unchanged.

This requires updated Vault and operator binaries, a fresh authenticated
deployment and a separate custody namespace. Installing the SDK alone does not
change an existing Pool. Follow [the adoption guide](../getting-started/non-expiring-deposits.md).

The canonical max-u64 expiry remains part of each Note's cryptographic identity;
it is not displayed as a distant calendar deadline. Request and withdrawal
proofs use the existing pinned circuit semantics.

Portable recovery retains the existing encrypted backup service and recovery
file format. The same wallet, deployment identity and profile pin restore the
latest saved balances, deposit selection and unresolved operations on another
browser. Exporting the file does not freeze the backup at that time. A restore
revokes the previous browser's write authority; uncertain authorizations and
signed transactions are retained rather than silently replayed.

Validation covers real proof/SBF execution, installed SDK acceptance,
file-only restoration in a fresh process, and Chromium origin-data deletion.
Separate-browser app tests cover deposits and balance changes made after file
export, wrong wallet/Pool rejection, and old-owner fencing. Hosted recovery
checks passed on 2026-10-25 with three synthetic new-Pool notes and the final
profile pin, using isolated Chromium contexts and separate Chromium-to-Firefox
and Chromium-to-WebKit runs. All requests were recovery-storage operations; no
wallet transaction or provider inference was performed. These results do not
establish public funded browser acceptance, Safari app or Phantom wallet
compatibility, or service availability guarantees.

The fresh public deployment identity is `public-devnet-20261025-nonexpiry-v1`.
Its finalized Pool has zero TTL and retains the 1,800-second withdrawal challenge
period. Matching operator services were activated and passed backend readiness
checks on October 25. This is separate from funded lifecycle acceptance; use
the [new-Pool guide](../getting-started/non-expiring-deposits.md).

Native installers remain at `.15`. Existing immutable release assets remain
available. The SDK is distributed as a GitHub tarball, not an npm publication.
