# Run an existing local browser relay

Use this procedure to serve an independently built browser application through
the repository's bounded local Devnet operator relay. New applications start
with [SDK setup](../sdk.md); neither the SDK nor clientd requires this relay.
The demonstration application's source and build instructions are maintained in
[solana-zkapi-client](https://github.com/yukikm/solana-zkapi-client).

This procedure requires an existing reviewed host configuration, authenticated
application build and original deployment inputs. It does not generate a new
public deployment or replace an existing wallet binding. Run from the pinned
zkAPI checkout with Node 24.19.0 and its installed dependencies.

## Serve a standalone application build

Build the application with its independently retained public-profile hash.
Set the private host configuration's `output` to that built directory. The
host authenticates `profile-build.json` and every asset before serving it.
Keep private RPC/backend configuration, keys and journals outside public assets.

```sh
node scripts/browser_chat_devnet_host.ts --config /private/host-config.json
```

Keep this process running. Open the configured numeric-loopback origin in the
browser. Use the same wallet account and storage identity as the original app,
and require successful authenticated profile/asset checks before new work.

## Serve a legacy fixed-wallet application

For an existing legacy installation, build its matching application in the
client repository and explicitly supply its static output:

```sh
node scripts/legacy_browser_devnet_host.ts \
  --config /private/existing-host-config.json \
  --ui-dir /absolute/path/to/built-legacy-client
```

This is an alternative for existing legacy custody, not the first-app setup.
Preserve the original origin/port, wallet account, storage name, note IDs,
deployment pins and parent budget. Changing the presentation source does not
migrate custody. Never initialize replacement state or overwrite a funded
journal. Restart with the same private configuration and authenticated build;
inspect [recovery status](../recovery.md) before another explicit request.

The offline `prepare_browser_chat_devnet.ts` helper is specific to its retained
Devnet campaign. Its private configuration is not an SDK distribution artifact.
For a new application or deployment use [deployment inputs](../deployment-inputs.md).
See the [relay component reference](../../../scripts/devnet-browser-relay/README.md)
for the enforced transport and financial guards.
