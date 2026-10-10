# Use the public Devnet deployment

Use this deployment to try Solana ZKAPI with test USDC. You need a wallet,
Devnet SOL for fees, and Devnet USDC for the note. The operator pays the real
provider bill. Check [support](../support.md) and fresh preflight before funding.

## 1. Choose a client

- [clientd](clientd.md): install the local daemon, then connect an AI client.
- [SDK](sdk.md): build ZKAPI into your own application.

Neither path requires your own provider API key or a ZKAPI server.

## 2. Use the published inputs

For a new installation, use **`0.2.0-devnet.8`** and the revision-6 profile:

| Input | Download |
|---|---|
| Public profile | [profile-sdk-0.2.0-devnet.8-r6.json](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.8-r6.json) |
| SDK | [zkapi-solana-sdk-0.2.0-devnet.8.tgz](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.8/zkapi-solana-sdk-0.2.0-devnet.8.tgz) |
| clientd, macOS ARM64 | [zkapi-clientd-0.2.0-devnet.8-darwin-arm64.tar.gz](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.8/zkapi-clientd-0.2.0-devnet.8-darwin-arm64.tar.gz) |

SHA-256 pins, in the same order:

```text
profile: ec10c1ab41bb5105222d3e25c7e1eba6b96b1b397abd0f854657030269992a77
SDK:     cd9226f4526c0b3561a557e4c7beb4f495dcbad6c995c624f4c442b6621414da
clientd: 14154d038bc0e79347076b9983754eeca2fbde78159be21e5ca7b0cddca632ac
```

The extracted native `release.json` pin is
`20c194668cbb9b13fecf8170c709fb03dd055bbd1b67b93b6e652dcfe7d118be`.
Verify pins through the authenticated [release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.8),
separately from the downloaded artifacts. Native support is Apple Silicon,
macOS 13.5 or newer; the archive is not Apple notarized.

Keep an existing funded installation's original profile, artifacts, wallet and
journal. These new-installation pins do not migrate existing notes. Earlier
downloads remain in [GitHub releases](https://github.com/yukikm/solana-zkapi/releases).

## 3. Check service access

The public API origin is `https://d366buuvadnp3.cloudfront.net`. Run the
read-only preflight in your [clientd](clientd.md) or [SDK](sdk.md) guide, then:

```sh
curl --fail --silent --show-error https://d366buuvadnp3.cloudfront.net/relay-status
curl --fail --silent --show-error https://d366buuvadnp3.cloudfront.net/provider-budget
curl --fail --silent --show-error https://d366buuvadnp3.cloudfront.net/zkapi/v1/readiness
```

Proceed only when new admission and transactions are enabled and readiness
succeeds. `/relay-status` reports policy; HTTP 200 from that route alone does
not prove readiness. `provider_credit: "not_checked"` means credit is unknown.

The public service uses operator-funded usage without a fixed trial allowance
and does not require an invitation. Check the returned policy before use. If a
different deployment requires an invitation, obtain it privately from its
operator. Never put it in a public profile, URL or log.

## 4. Fund your wallet

For a browser app, connect your selected Wallet Standard account on Devnet.
For clientd, use an existing dedicated Devnet keypair or create one locally.
If needed, install the [Solana CLI](https://solana.com/docs/intro/installation/dependencies#install-solana-cli)
first. Run these commands yourself in a private terminal:

```sh
umask 077
mkdir -p "$HOME/.config/zkapi-wallets"
chmod 700 "$HOME/.config/zkapi-wallets"
solana-keygen new --outfile "$HOME/.config/zkapi-wallets/devnet.json"
chmod 600 "$HOME/.config/zkapi-wallets/devnet.json"
solana-keygen pubkey "$HOME/.config/zkapi-wallets/devnet.json"
```

Save the recovery phrase and any passphrase privately. The keypair command
refuses to overwrite an existing file; do not add `--force`. Use this file's
absolute path for `--wallet` in [clientd setup](clientd.md).
These commands do not change your default Solana wallet or cluster.
Only the printed public address is needed for faucets.

1. Open the [Solana faucet](https://faucet.solana.com/) and request Devnet SOL
   for that address. SOL pays transaction fees and account rent.
2. Open [Circle's faucet](https://faucet.circle.com/), select **USDC** and
   **Solana Devnet**, and request test tokens for the same address.
3. Confirm the authenticated profile and wallet use this six-decimal mint:
   `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
4. Return to your client guide and deposit into the ZKAPI note. Wait for
   finalized completion before sending inference.

Mainnet USDC and other tokens named USDC cannot fund this deployment.
Faucet limits vary; see the official [Solana faucet instructions](https://solana.com/developers/cookbook/development/airdrops-and-faucets)
and [Circle mint list](https://developers.circle.com/stablecoins/usdc-contract-addresses).

Amounts use integer micro-USDC: `2000000` is 2 USDC. The profile has a
`1000000` session cap, so a 2-USDC deposit leaves room for subsequent requests.
The cap is a reservation limit; the signed charge is the actual settled amount.
A balance below the cap cannot authorize another session.

## 5. Use and recover

This profile uses direct OpenRouter Chat Completions with a 128-token maximum
output. Prompts go to OpenRouter. A listed model is not a guarantee of current
provider availability or credit. Browser requests must omit cookies
(`credentials: "omit"`).

After interruption, reopen the same client storage and use its recovery action.
Do not clear storage or repeat an uncertain deposit or inference request.
Withdraw through [clientd](clientd.md) or the [SDK recovery API](../sdk/recovery.md).
