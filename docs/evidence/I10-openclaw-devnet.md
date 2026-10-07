# I10 — actual OpenClaw through installed native runtime on devnet

Recorded 2026-10-07 JST. [Results](I10-openclaw-devnet-results.json) and the
[independent finalized chain collection](I10-native-openclaw-devnet-chain-results.json)
record actual OpenClaw 2026.9.8, native proof generation, public devnet and direct
OpenRouter inference on `openai/gpt-4o-mini`.

## Observed lifecycle

A fresh private native profile deposited **2,000,000 micro-USDC** with a single
995-byte compact transaction. The actual OpenClaw CLI then:

1. Received `ZKAPI_NATIVE_TEXT_OK` through HTTP 200 SSE, with six content deltas
   and `[DONE]`. This used one provider inference and one authorization.
2. Executed its real `read` tool once against a prepared local file and submitted
   the matching tool result in a distinct continuation request. Both HTTP 200
   SSE responses completed; the visible answer was `ZKAPI_NATIVE_TOOL_OK`.
   Saved exact native requests corroborate the matching tool-call ID and result.
   The two requests shared the second authorization with 60-second key reuse.

Provider retries were disabled in the dedicated OpenClaw agent settings and
model fallbacks were empty. The acceptance fence allowed at most two distinct
exact-body authorization UUIDs and three inference dispatches. Unknown inference
and repeated operation UUIDs were fenced. Actual recorded totals were **two
unique authorizations, three inference dispatches and zero inference replays**.
The authorization count is not an independently observed HTTP packet count.

Explicit close waited for asynchronous provider disable/stable-usage/final-usage
settlement. The installed SDK verified signed charges of **627** and **659
micro-USDC**, totaling **1,286 micro-USDC**. The note reached ready with no
pending session before each subsequent lifecycle phase. A closing response alone
was not accepted as completed settlement.

After both settlements, the native runtime and frontend stopped and restarted
against the same custody/profile/journal. The entire redacted inspection,
journal head, balance and dispatch counts were unchanged; no new authorization,
inference or transaction occurred. This is a clean settled restart, not public
unknown-inference crash recovery. Ordinary mutual close returned **1,998,714
micro-USDC**. All six wallet transactions finalized without a repeated saved
signature. The new acceptance processes stopped after withdrawal with harness
exit status 0. The original operator backend, indexer and host were preserved.

An independent read-only collector subsequently checked signed versioned
transaction bytes, saved wire hashes, instructions, reconstructed withdrawal
payload, token deltas and final accounts. It observed **six finalized
transactions**, maximum **348,111 CU / 1,232 bytes**, and a finalized balance cut
at slot **508316171**: Vault zero and note closed. Wallet balance was 36,010,000
micro-USDC; this wallet is also treasury owner, so that restored balance does
not erase the separately verified 1,286-micro-USDC charge.

## Exact execution boundary

This live path ran the **installed native SDK runtime and production Go HTTP
handler**. An explicit acceptance adapter supplied the Unix egress through the
existing bounded operator devnet host; direct inference went to OpenRouter.
The adapter also applied the already authorized parent budget fence before
AUTH. It used a fresh private journal, custody key, passphrase and note, while
preserving all old private state and deployment pins. User wallet secrets were
passed through private stdin and were not copied into public evidence.

This does **not** establish public deployment of the complete installed Go
`clientd serve` supervisor and its normal network policy. That complete
supervisor, installed dependencies, actual native proof/SBF, lost transaction
result and restart are verified separately by the
[local package acceptance](I10-clientd-external.md). Actual OpenClaw HTTP 503,
process cancellation and uncertain inference recovery are also separate local
fixture tests. No extra public fault injection or inference replay was used.

The live profile was frozen before the final optional SDK SSE-reader correction:

- Live SDK archive: `3e601fae1d41a804a3c59b10c0eb88052bbedd0ba9317ad88e7cdb9fad06ebbd`.
- Live distribution manifest: `1cf1b2f558560c8deeefef493c596ee2509f144283127706cb214ca1abde4382`.
- Final portable SDK archive: `fc37358ce00fa7bcb5c43367c8f09b3908c617f9235e8646ae78003a21040c91`.
- Final portable distribution manifest: `1902708439fe8551e803845ecc03a25fd985efb2838ef5157130494477c19677`.

Native OpenClaw relays raw SSE and uses OpenClaw's reader; it does not call the
optional SDK reader corrected in the final archive. The final portable package
was freshly tested with installed native/SBF and actual OpenClaw fixtures. The
live profile was not replaced or relabeled as that later package.

## Reproduction and preservation

The explicit adapter is `scripts/clientd_devnet_live.mjs`. Its commands separate
fresh `init`, foreground `serve`, bounded `action text` / `action tools`, and
existing SDK wallet/status/close operations. It requires independently reviewed
profile/bundle pins, an installed distribution, the existing bounded devnet
operator transport and authorized budget. It is an acceptance adapter, not a
default deployment configuration or a reusable private profile.

The executed order was fresh setup, deposit/advance to finalized active,
OpenClaw text, close to signed settlement, OpenClaw read/continuation, close to
signed settlement, clean same-profile restart, ordinary withdrawal/advance,
and independent finalized collection. Closed private state remains under
`target/native-openclaw-devnet`; the exact public projection and manifest are
preserved with the chain collector's component evidence. Logs and provider
responses remain private, with only safe outcomes and hashes in the report.

The shared immutable parent budget retains all earlier reservations. These two
native authorizations add two full 1,000,000-micro-USDC worst-case reservations;
actual native signed charges total 1,286 micro-USDC. The overall budget accounting
is recorded in the parent integration evidence. No claim is made for a default
public operator, hosted CI, mainnet, signed distribution, an external security
audit, Phantom or full I10/G1–G4 release acceptance.
