# Migrate to the native Solana Kit API

The `0.2.0-devnet.1` SDK source uses `@solana/kit` 8.4.0 directly. This is a
breaking TypeScript API update from the first preview. The SDK, clientd runtime
and reference application no longer require the legacy Solana JavaScript client
or a compatibility package. Existing protocol deployment pins and journal
identities remain unchanged.

The release target is
[`v0.2.0-devnet.1`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.1),
with SDK asset
[`zkapi-solana-sdk-0.2.0-devnet.1.tgz`](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.1/zkapi-solana-sdk-0.2.0-devnet.1.tgz).
Confirm publication and the independently trusted checksums before using release
assets. A source version or local build does not establish publication. The
immutable first preview and its evidence retain their original contents.

## Addresses and RPC

Use validated Kit `Address` strings instead of key objects. Compare addresses
with `===`; encode or decode their bytes with Kit's address codecs.

```ts
import { address, createSolanaRpc, getAddressEncoder } from '@solana/kit';

const pool = address(reviewedPoolAddress);
const poolBytes = getAddressEncoder().encode(pool);
const connection = createSolanaRpc(reviewedRpcUrl);
const result = await connection.getAccountInfo(pool, {
  commitment: 'finalized',
  encoding: 'base64',
}).send();
// result.context.slot and result.value?.lamports are bigint.
```

Keep the `ClientDeployment.connection` option name and supply this
`Rpc<SolanaRpcApi>` value. SDK financial reads explicitly use finalized
commitment. Kit RPC methods return a request whose `.send()` performs the call.
Account bytes arrive as a base64 tuple when that encoding is requested.

Preserve bigint RPC values. Convert a slot or height to a number only after
checking it is nonnegative and no larger than `Number.MAX_SAFE_INTEGER`. The
SDK performs this check at its existing number-based journal boundaries; USDC
accounting continues to use integer micro-USDC.

An application with an existing bounded fetch or an approved local relay can
install it explicitly:

```ts
import { createSolanaRpcWithFetch } from '@zkapi/solana-sdk/transport';

const connection = createSolanaRpcWithFetch(reviewedRpcUrl, boundedFetch);
```

This returns a native Kit RPC client, uses lossless Kit JSON codecs, preserves
explicit commitment fields for relay policy checks, and sends each call once.
The supplied fetch must enforce the host's timeouts, routing and credential
policy. `deployment.fetch` configures control/indexer/inference HTTP separately;
it does not replace the RPC transport.

## Wallets and transaction signatures

`V0Wallet.publicKey` retains its property name but now contains an `Address`.
`signTransaction` accepts and returns a native Kit `Transaction` with
`messageBytes` and an address-keyed `signatures` map. Transactions have no
mutable signing method. A native host can adapt an existing Kit signer:

```ts
import { partiallySignTransaction, type KeyPairSigner } from '@solana/kit';
import type { V0Wallet } from '@zkapi/solana-sdk/transport';

function adaptSigner(signer: KeyPairSigner): V0Wallet {
  return {
    publicKey: signer.address,
    supportedTransactionVersions: new Set([0]),
    signTransaction: transaction =>
      partiallySignTransaction([signer.keyPair], transaction),
  };
}
```

Browser hosts keep using `walletStandardAdapter` for their explicitly selected
connected account. It encodes the native Kit transaction for Wallet Standard
and decodes the wallet's signed bytes. The SDK still checks exact message bytes,
required signer identities and every signature; an adapter must not rebuild or
alter the transaction it was asked to sign.

`compileV0` now returns a Kit `Transaction`; `Step.instruction` is a Kit
`Instruction` with `programAddress`, `accounts` and `data`. Account metadata uses
an `address` and Kit `AccountRole`. Advanced callers can use the standard Kit
transaction codecs for their own copies; SDK signing and recovery perform
additional canonical-wire checks.

## Await address derivation and validation

Kit derives PDAs asynchronously through Web Crypto. These lower-level SDK
functions are now asynchronous and must be awaited:

- `associatedTokenAddress` and `vaultAccounts`.
- `validateInlineDepositPlanRecord` and `validateInlineDepositAttemptRecord`.
- `validateNoteJournal` and the source-level `challengerWallet` helper.

Pass `validateNoteJournal` to `EncryptedJournal` as before. The journal awaits
validation before accepting reads, commits or backup restores and snapshots
caller input before any wait. If calling the validator directly, use
`await validateNoteJournal(value)`; a synchronous assertion around the returned
promise cannot detect rejection. The application methods such as
`prepareDeposit`, `advanceWallet`, `request` and `recover` retain their existing
asynchronous lifecycle.

## Existing journals and proof deployments

The migration preserves schema 1 buffered attempts and schema 2 inline deposit
records. Address fields stay base58 strings, signed transactions remain v0, and
saved signatures, blockhashes, proof payloads, account roles and deployment pins
are not rewritten. Keep the original custody key, storage identity and deployment
configuration when upgrading a funded or unresolved note.

The [pre-migration wire fixture](../../tests/fixtures/kit/transport-wire-v1.json)
and [wire/recovery regression](../../packages/sdk/test/kit-wire.test.ts) compare
newly compiled messages and signed bytes against 31 signed originals captured
from source `bae1240`. They cover all five buffered operations, buffer close,
standalone finalization, and compact deposits with zero/nonzero priority fees,
and exercise old-attempt recovery without permitting transaction submission. This
is local compatibility evidence. It does not establish a new public-chain,
provider or external-wallet acceptance pass.

An uncertain inference or financial operation keeps its existing recovery
rules. A library upgrade does not authorize creating a replacement deposit,
changing a manifest, replaying inference, or clearing an unresolved journal.
