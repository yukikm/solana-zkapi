# Public RPC credential rotation

Recorded through **2026-10-08 17:04:59 UTC**. The user supplied a replacement
Devnet RPC credential after the previous primary stopped serving the writer
and indexer. This checkpoint records the configuration change and startup;
**public readiness was not restored at this cut**.
[Exact redacted receipts and hashes](PD-public-rpc-key-rotation.json) retain
the failures and successful continuation.

The previous primary returned HTTP 429 for writer `getGenesisHash` and
indexer `getSlot`; the saved error body was `max usage reached`. A separate
single-read check of the earlier Alchemy endpoint again returned an explicit
monthly-quota error. These are preserved observations, not a quota-reset or
provider-plan diagnosis. The replacement credential passed exactly two reads
from the AWS host: Devnet genesis and finalized slot `508879447`, both HTTP
200. This does not establish sustained catch-up capacity. The preceding
[signature-status routing correction](PD-public-signature-status-route.md)
and [historical quota report](PD-public-rpc-quota-blocker.md) remain separate.

The guarded rotation stopped gateway, control, follower and writer, then
changed only their four primary-RPC fields. Independent history/secondary
RPC settings, public profile and SDK release stayed unchanged. Original
configuration bytes were retained; the existing database, reservation ledger
and archive inventory were guarded. No funding, AUTH, inference, transaction
send, paid upgrade or automatic endpoint fallback was added.

The first startup command successfully started control, which also activated
its declared indexer dependency. The preparer's assumption that the indexer
would remain inactive then refused further work. A read-only cut confirmed
those two active services and the still-stopped writer and gateway. A new,
explicit continuation started **only the writer**, preserving the already
active services. It made no readiness claim. The reported apply and
continuation receipt hashes are `a7ed2a8aa6eae3329a366badf311e5c25dd0bd309e7f9b3d204e0adcbb5b2670`
and `7a40ccfa641f4d9492187ec350f09f47cb1ad7f9ff857682db69cd8b5cafbe9f`.
They are joined to the saved successful SSM outputs; their complete raw host
receipt files were not downloaded in this checkpoint.

Both later combined receipt/health collectors failed their final compressed
output-size bound and emitted no report. Neither failure establishes a
runtime failure or an HTTP 200 result. At the independent 17:04:59 cut,
writer and follower were running, gateway was inactive, and the retained
writer health record was 1,176 seconds old with `ready=false`. The archive
contained 343,925 blocks in 18,950 chunks through slot `508866844`. The local
root observation reported `URLError`, without an HTTP-status claim. The
separate OpenRouter parity update had changed control by then; it is not
part of this primary-only rotation. Catch-up, restored public readiness and
E01's remaining wallet lifecycle require later actual observations.
