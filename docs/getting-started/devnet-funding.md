# Devnet funding and access

For clientd, complete [installation and preflight](clientd.md) first; the same guide
contains the exact deposit and withdrawal commands. SDK applications use the
[funding workflow](sdk.md#4-select-the-wallet-create-storage-and-fund).

The preview uses Circle Devnet USDC, six decimals, mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, with SPL Token program
`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. Match these against the
authenticated profile and finalized Pool before funding. Circle lists this
mint in its [official USDC address table](https://developers.circle.com/stablecoins/usdc-contract-addresses).
Tokens merely named USDC and mainnet transfers cannot fund this Devnet note.

1. Select your own wallet and its Devnet account. Confirm the destination address
   shown by the wallet and application matches.
2. Use [Circle's faucet](https://faucet.circle.com/), choose **USDC** and
   **Solana Devnet**, then enter that address. Observe the faucet's current
   limits. No operator management key is required.
3. Obtain Devnet SOL separately from the
   [Solana Foundation faucet](https://faucet.solana.com/). SOL covers transaction
   fees and account rent; token principal does not. The
   [official faucet guide](https://solana.com/developers/cookbook/development/airdrops-and-faucets)
   documents alternatives and rate limits.
4. Run read-only deployment preflight. Confirm the exact mint, six decimals,
   account owner, finalized wallet balances, selected model and admission status.
   Review the wallet's fee/rent estimate before signing.
5. Explicitly prepare a deposit and advance the saved operation until it is
   finalized. An HTTP success or wallet signature alone is not an active note.

Amounts are integer strings in micro-USDC. For a profile whose authorization cap
is `1000000`, `2000000` deposits two test USDC and leaves headroom for further
requests. If the first verified charge is `4`, the note balance is `1999996`.
The next request still needs the full cap available; depositing exactly the cap
can prevent a second request after a nonzero charge. Cap, actual charge, remaining
note principal and SOL fees/rent are distinct quantities.

## Access and real provider spending

Devnet faucet tokens do not purchase provider credit. The operator pays the real
provider bill separately; consumers do not need provider-management credentials.

The public gateway does not require an invitation and uses operator-funded usage
without a fixed trial allowance. Check fresh preflight, `/relay-status` and
`/provider-budget` before depositing for new requests.

Schema 2 budget status reports `budget_scope: operator_funded` and
`trial_limits: false`, with no remaining-request counter. The pinned per-session
cap and note-balance checks remain. `provider_credit: not_checked` does not claim
unlimited credit; actual OpenRouter charges are paid by the operator. Other
deployments can retain schema 1 finite allowances and must honor their limits.
A reservation covers maximum exposure, even when the signed charge is smaller.

For another deployment that requires an invitation, obtain it privately from
its operator. Keep it out of URLs, shared configuration and issue reports.
An invitation does not override suspended admission or capacity limits.

## When a request cannot proceed

| Condition | User action |
|---|---|
| Wrong network/mint/profile | Stop before deposit; restore the reviewed configuration |
| Low wallet SOL | Obtain Devnet SOL for fees/rent; preserve any pending operation |
| Note below authorization cap | Settle existing work first; inspect the note and funding lifecycle |
| New admission suspended or invitation/capacity unavailable | Do not start a new AUTH; consult the dated operator notice and preserve existing operations |
| Provider or required service unavailable | Stop new work; existing recovery may also need services to return during maintenance |
| Uncertain inference or transaction | Inspect the same journal/UUID; explicitly recover without replay |
| Profile retired or service outage | Retain the original profile/custody and use its recovery route or documented escape/finalize |

Never clear browser storage or create a replacement note to make an error
disappear. Suspending new admission preserves existing request identities; it
does not prove that every recovery endpoint is currently online. Read
[recovery](recovery.md) and the [incident procedure](operators/incidents.md#incident-and-maintenance-procedure)
before acting on unresolved funds.
