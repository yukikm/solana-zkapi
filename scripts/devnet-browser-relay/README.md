# Local devnet operator relay

This directory contains the bounded financial relay used by local development
clients. It contains no browser application, CSS, bundler or wallet picker.
The demonstration applications and their tests now live in
[solana-zkapi-client](https://github.com/yukikm/solana-zkapi-client).

`host.ts` retains numeric-loopback, Host/Origin, authenticated manifest, devnet,
transaction signature/program/pool/fee and parent budget checks. `profile.ts`
validates the public profile wire format independently of any application build.
Neither the SDK nor clientd requires this demonstration operator relay.

For an existing independently pinned standalone build, continue using:

```sh
node scripts/browser_chat_devnet_host.ts --config /private/host-config.json
```

The configuration's `output` is the built directory from the client repository.
The host authenticates `profile-build.json` and every asset before serving it.
Build that directory with the separately retained public profile hash. Keep
private RPC/backend configuration, keys and journals outside public assets.

For the historical fixed wallet demonstration, build it in the client repository
and serve the resulting static directory explicitly:

```sh
node scripts/legacy_browser_devnet_host.ts \
  --config /private/existing-host-config.json \
  --ui-dir /absolute/path/to/built-legacy-client
```

Keep the existing origin/port, wallet account, storage name, note IDs, deployment
pins and parent budget for recovery. Moving presentation source does not migrate
custody. Do not initialize replacement state or overwrite a funded journal. The
existing running host and previously authenticated output can continue running
while the source moves; restarting requires the new command above.

`prepare_browser_chat_devnet.ts` remains an offline operator helper for the
existing devnet campaign. Its private configuration is not an SDK distribution
artifact. New app integration follows the [SDK deployment guide](../../docs/sdk/deployment.md).
