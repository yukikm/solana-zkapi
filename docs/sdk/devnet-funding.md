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

Devnet faucet tokens do not purchase real provider credit. The preview operator
covers provider charges using the separately authorized acceptance budget;
ordinary consumers do not supply provider-management credentials or send mainnet
USDC to obtain faucet funds. The campaign accounts for provider exposure using
the reviewed one-USD-to-one-USDC assumption; faucet balances and the real
provider bill remain separate.

The [initialized grant](../evidence/PD-detached-budget-initialization.md) allows
at most **seven new AUTH reservations of 1,000,000 micro-USDC each**, a total
seven-USDC maximum exposure, for the named B-01–B-03 and N-01–N-04 acceptance
cases. It selects direct OpenRouter Chat, `openai/gpt-4o-mini`, a 60-second session
TTL and at most 128 output tokens. This is a bounded, invitation-only campaign,
not an ongoing public spending allowance. Reservations are retained even when
the verified charge is smaller; no automatic retry or replacement grant is
authorized.

At the [N-01 checkpoint](../evidence/PD-native-public-N01.md) on
2026-10-08 at 06:54 UTC, a five-USDC **Devnet** deposit had finalized and one
response had settled for 6 micro-USDC, leaving an active note balance of
4,999,994. The [07:43 operator join](../evidence/PD-N01-operator-join.md)
independently matched its one full-cap reservation and signed settlement.
Admission was subsequently suspended at 07:58 UTC. These are dated observations,
not permission to fund or send a request now; consult the
[operator status and incident guide](public-devnet-operations.md).

Request an invitation from the deployment operator through the repository
maintainer's private communication channel. There is no public invitation code.
An invitation does not reserve capacity, override suspended admission or authorize
an additional campaign. Keep it out of URLs, shared configuration and issue
reports. Browser connections hold it in memory; native installation uses an
owner-only file scoped to the exact AUTH endpoint.

The previous private campaign remains separate: its historical 17 reservations
total 9,154,216 of 10,000,000 micro-USDC, leaving 845,784. No original capacity
was transferred to the new grant, and reservations must never be reset or
reclaimed to retry a case. Installing a profile alone authorizes no spending.

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
[recovery](recovery.md) and the [incident procedure](public-devnet-operations.md#incident-and-maintenance-procedure)
before acting on unresolved funds.
