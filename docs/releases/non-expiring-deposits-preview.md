# Non-expiring deposits preview

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

Local validation covers real proof/SBF execution, installed SDK acceptance,
file-only restoration in a fresh process, and Chromium origin-data deletion.
Separate-browser app tests cover deposits and balance changes made after file
export, wrong wallet/Pool rejection, and old-owner fencing. These checks do not
claim public funded browser acceptance, cross-engine compatibility or service
availability guarantees.

Native installers remain at `.15`. Existing immutable release assets remain
available. The SDK is distributed as a GitHub tarball, not an npm publication.
