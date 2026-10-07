# Kit preview 0.2.0-devnet.1

This developer preview replaces every active JavaScript Solana client dependency
with `@solana/kit` **8.4.0**. The SDK, native clientd runtime, external application
examples, Demo UI and local acceptance tools no longer depend on `@solana/web3.js`
or its compatibility package, including transitively installed dependencies.
Historical reports and immutable earlier releases remain available as evidence.

The SDK's low-level TypeScript API changes: addresses are Kit `Address` strings,
RPC clients are `Rpc<SolanaRpcApi>`, and wallet signing uses Kit `Transaction`.
PDA construction and journal validation are asynchronous. Read the
[Kit migration guide](../sdk/kit-migration.md) before upgrading an application.
The application facade's deposit, inference and withdrawal lifecycle is retained.
Existing journal schemas and signed v0 transaction bytes are preserved; upgrading
does not authorize replaying an uncertain transaction or inference.

## Distribution

The [GitHub release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.1)
provides the compiled SDK archive, the current-platform native daemon archive,
`release-manifest.json` and `SHA256SUMS`:

- `zkapi-solana-sdk-0.2.0-devnet.1.tgz`
- `zkapi-clientd-0.2.0-devnet.1-darwin-arm64.tar.gz` (Apple Silicon, macOS 13.5+)

Verify the artifact digest from a trusted release before installation. Install the
SDK using `npm install ./zkapi-solana-sdk-0.2.0-devnet.1.tgz`. Extract native clientd
into a new directory and follow the [private profile setup](../sdk/clientd-quickstart.md).
Retain an existing profile and custody/journal backups during upgrades; do not
initialize new custody over an existing profile. Review and repin the new
installation manifest before using it with an existing profile.

## Scope

This release remains a devnet developer preview. It does not supply a default
public operator, mainnet deployment, complete proving asset bundle, new funded
provider acceptance, Apple notarization or a third-party audit. Earlier live
SDK/OpenClaw observations belong to the earlier source and transport; they are
not new live acceptance of Kit. Claude Code and Codex request compatibility
blockers remain unchanged. The previously authorized immutable provider budget
and existing private journals are not changed by this migration.
