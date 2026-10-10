# Local Devnet operator relay reference

This directory contains the bounded financial relay used by local development
clients. It contains no browser application, CSS, bundler or wallet picker.
Application source and tests live in
[solana-zkapi-client](https://github.com/yukikm/solana-zkapi-client).

For startup and custody-preserving restart, use
[Run an existing local browser relay](../../docs/getting-started/operators/browser-relay.md).
New application integration starts with [SDK setup](../../docs/getting-started/sdk.md).
Neither the SDK nor clientd requires this demonstration operator relay.

`host.ts` enforces numeric-loopback, Host/Origin, authenticated manifest, Devnet,
transaction signature/program/Pool/fee and parent budget checks. `profile.ts`
validates the public-profile wire format independently of an application build.
The standalone host authenticates `profile-build.json` and its exact asset
inventory before serving the separate application output.

`prepare_browser_chat_devnet.ts` is an offline helper for the existing Devnet
campaign. Its private configuration is not an SDK distribution artifact;
see [deployment inputs](../../docs/getting-started/deployment-inputs.md).
