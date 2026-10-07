# Solana zkAPI SDK

An application API for USDC-funded AI usage. It composes the existing wallet,
proof generation, encrypted storage, authorization and verified settlement.
Applications keep control of their UI, conversation history and provider mode.

**Start here:** [Quickstart](../../docs/sdk/quickstart.md) ·
[API reference](../../docs/sdk/api.md) ·
[separate reference client](https://github.com/yukikm/solana-zkapi-client).

Install the reviewed npm tarball with compiled ES modules and TypeScript
declarations from an independent application. See [distribution and artifact
setup](DISTRIBUTION.md). The package is version `0.1.0-devnet.1`, with `private: true` to
prevent accidental npm publication. Node integrations use Node 24.19.0; browser
integrations bundle the browser entry points. Do not install an unrelated
registry package just because it has this name.

The SDK is [MIT licensed](LICENSE). Its dependencies retain their own licenses.

| Import | Purpose |
|---|---|
| `@zkapi/solana-sdk` | `createZkApiClient`, `ZkApiClient`, application types |
| `@zkapi/solana-sdk/browser` | Browser factory, durable custody, Wallet Standard adapter |
| `@zkapi/solana-sdk/deployment` | Download and verify an independently pinned public artifact bundle |
| `@zkapi/solana-sdk/chat` | Bounded text and streaming response readers |
| `@zkapi/solana-sdk/prover-worker` | Entry point to bundle as a module Worker |
| Existing subpaths (`./wallet`, `./control`, etc.) | Advanced integration; preserved |

The factory validates independent deployment pins, artifact hashes, RPC genesis
and finalized PoolConfig. It does not connect a wallet, initialize a deposit,
recover a pending AUTH or send inference. Model tariffs must match the pinned
deployment; model configuration is not proof of live provider compatibility.

Use one stable local note ID and the same browser origin/storage. Consume or
cancel every response. New inference is blocked while a session, wallet
operation or permanent clearance remains unresolved. Explicit recovery uses
saved authorization and journal state; inference is never automatically replayed.

The application API closes each inference session after response consumption or
cancellation. Close can remain pending, so inspect `status()` and use `recover()`.
The advanced clientd interface retains its configurable key reuse policy.

## Single-signature deposit

Compact-enabled, independently pinned deployments use the same one-signature
deposit path through the application API. Older deployments keep buffer uploads.

Protocol integration details, custody boundaries, single-signature deposits and
the original transport contract are preserved in [INTERNALS.md](INTERNALS.md).
Public compact-deposit/Phantom acceptance and release readiness remain separate
from local SDK tests. See [status](../../docs/sdk/status.md).
