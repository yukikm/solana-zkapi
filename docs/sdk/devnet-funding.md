# Devnet funding and access

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

Devnet tokens have no financial value and do not purchase provider credit.
The operator must publish who subsidizes inference, the authorized spend ceiling,
per-AUTH cap, admission/rate limits, availability window and any invitation
process. A new public subsidy policy has not been activated by this code change.
Do not ask ordinary consumers for operator provider-management credentials.

The previous private acceptance campaign is not a public subsidy. Its immutable
17 reservations total 9,154,216 of 10,000,000 micro-USDC, leaving 845,784. That
capacity cannot admit another full one-USDC AUTH. A new authorized campaign or
explicit budget extension must preserve every old reservation; installing a
profile never authorizes new spending.

## When a request cannot proceed

| Condition | User action |
|---|---|
| Wrong network/mint/profile | Stop before deposit; restore the reviewed configuration |
| Low wallet SOL | Obtain Devnet SOL for fees/rent; preserve any pending operation |
| Note below authorization cap | Settle existing work first; inspect the note and funding lifecycle |
| Admission/subsidy/provider unavailable | Wait for operator admission to reopen; keep settlement/recovery/withdrawal available |
| Uncertain inference or transaction | Inspect the same journal/UUID; explicitly recover without replay |
| Profile retired or service outage | Retain the original profile/custody and use its recovery route or documented escape/finalize |

Never clear browser storage or create a replacement note to make an error
disappear. Read [recovery](recovery.md) before acting on unresolved funds.
