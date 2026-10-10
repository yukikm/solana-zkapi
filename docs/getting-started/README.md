# Getting started

Choose what you want to do. Each guide lists its prerequisites and commands.
This project is a **Devnet preview**; check [support](../support.md) first.

## Use ZKAPI

- [Install and run clientd](clientd.md) — download, connect, fund and start the local API.
- [Devnet funds and connection details](devnet.md) — SOL, test USDC and deployment verification.
- [Connect OpenClaw](openclaw.md) after clientd is funded, or use the local API from your own client.

These clients have configuration guides, but their current request formats
are not supported for normal use:

- [Claude Desktop](claude-desktop.md)
- [Claude Code](claude-code.md)
- [Codex](codex.md)

## Build an application

[Integrate the SDK](sdk.md) for wallet funding, proofs, inference and recovery.
A custom application can use the SDK directly without clientd.

## Operate a service

1. [Create a new Devnet deployment](deployment.md), or prepare your existing verified deployment inputs.
2. [Set up the operator services](proxy-operator.md) and [connect an API provider](api-provider.md).
3. For the supplied public gateway, use the [gateway configuration](gateway.md).
4. Set up [monitoring and recovery](operations.md), [backup and restart](backup-and-restart.md),
   and [archive storage](archive-storage.md).

Operator setup requires a matching Solana program, Pool, keys and deployment
artifacts. This repository does not provide a production-ready one-command installer.
