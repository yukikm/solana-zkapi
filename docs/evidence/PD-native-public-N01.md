# Native public N-01: response and verified settlement

The independently installed stock native client completed the N-01 deposit, nonstreaming Chat response and cryptographically verified metered settlement through the public HTTPS transport on 2026-10-08. The signed balance is **4,999,994 micro-USDC** after a **6-micro-USDC** charge. **The note remains active; funds have not been withdrawn.** This checkpoint ends at 06:54:45 UTC. Exact retained digests and limits are in the [JSON report](PD-native-public-N01.json).

## Deposit and public transport

After the separately recorded [wallet-route correction](PD-public-wallet-route-fix.md), explicit native preparation and advancement produced one finalized `deposit_compact_v1` transaction for 5,000,000 micro-USDC. Independent chain observation matched its signature and exact wire: **995 bytes**, **184,417 CU**, finalized slot **508730317**, and 5,000 lamports transaction fee. The later deposit balance cut at slot **508731005** showed wallet **31,010,000 micro-USDC**, Vault **5,000,000**, and active note zero. This observation preceded inference and is not a withdrawal result.

The chain collector retained an operator-supplied `N-04` checkpoint label. Its transaction-source hash instead joins the actual N-01 funded observer, and its signature/wire match the N-01 journal. That label is preserved and does not mean N-04 ran.

The immutable native release manifest remains `0b5733718f51eabcf4ca57f2406eb36bab641e23d642aac2436ca0e3090572ca`, with SDK archive `fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc`. The stock supervisor and Go egress were used, without a custom Devnet relay or disabled TLS. The execution precheck verified all 37 prepared inputs and the exact funded/chain reports.

## Response, exact AUTH and settlement

The durable one-shot driver invoked one local POST with operation `98981b0b-e6d3-4fee-af41-70765fb93a3e`. It received HTTP 200, fully consumed and durably retained the 845-byte JSON response in **16.348 seconds**, and recorded no local retry or redirect. Returned metadata identifies `openai/gpt-4o-mini`, 15 input and six output tokens. These response fields are separate from billing verification.

The captured pending journal binds authorization request `9cb0fa34-5188-411c-80ac-a37385c79661` to exact AUTH SHA-256 `395719fc67d20eab9ea9efb244d5c9878d3785d1e5ec4f2dd35a5e8bfaa662ef`. Settled history retains only the request object: its canonical digest `2b76f941984f8ae34f5341459ea8bcbaed5faf6f6f712530b712cbe6aef2c293` is **not** the exact sent-byte digest. The two must not be substituted.

At 06:49 UTC the retained observation was still closing, with a `send_unknown` operation. The ordinary running daemon later completed settlement; no explicit recovery or inference replay was requested. At 06:54:45 UTC, an independent offline native verification accepted one `OPENROUTER_USAGE` receipt marked `metered`/`charge`, with **5,850 nano-USDC**, rounded upward to **6 micro-USDC**. It also verified the signed successor, the exact operation association and balance **4,999,994**. Pending state was null, status was ready, recovery was unnecessary, and the journal head was revision **371**. No waiver or not-dispatched receipt was relabeled as paid acceptance.

A separate read-only operator database diagnostic corroborates the same settled request, signed six-micro-USDC settlement and final usage checkpoint. The independent H03 authority/state-hash and operator message-digest join is still pending at this cutoff. One full-cap reservation is reported for the separate seven-cap grant; it is not the measured six-micro-USDC charge. The historical 17-row original ledger remains a separate preserved authority, with no capacity transfer, reset or reclamation; this report adds no fresh original-ledger hash observation.

## Remaining scope

One local POST does not prove an upstream packet count. Provider inference sends/replays, AUTH HTTP packets and transaction resends remain unmeasured where the collectors report null. The pending observer's status and journal reads occurred at different revisions and are not presented as an atomic cut.

Admission suspension, same-state encrypted backup/restart, OpenClaw N-02/N-03, the interrupted N-04 recovery/withdrawal case and funded browser cases remain unfinished. A clean eventual settlement is not a crash-recovery test. The last independent Vault balance is the pre-inference five-USDC deposit cut; no mutual close or return of funds is claimed.
