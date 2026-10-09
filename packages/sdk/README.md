# Solana zkAPI SDK

An application API for USDC-funded AI usage. It composes the existing wallet,
proof generation, encrypted storage, authorization and verified settlement.
Applications keep control of their UI, conversation history and provider mode.

**Start here:** [Quickstart](../../docs/sdk/quickstart.md) ·
[API reference](../../docs/sdk/api.md) · [Kit migration](../../docs/sdk/kit-migration.md) ·
[separate reference client](https://github.com/yukikm/solana-zkapi-client).

Install the reviewed npm tarball with compiled ES modules and TypeScript
declarations from an independent application. See [distribution and artifact
setup](DISTRIBUTION.md). This checkout builds `0.2.0-devnet.3`; download availability
and verification are recorded in the [public deployment guide](../../docs/sdk/public-devnet-preview.md).
Earlier immutable preview releases remain unchanged. The package uses
`private: true` to prevent accidental npm publication. Node integrations use Node 24.19.0; browser
integrations bundle the browser entry points. Do not install an unrelated
registry package just because it has this name.

This version uses `@solana/kit` 8.4.0: addresses are validated branded strings,
RPC uses `Rpc<SolanaRpcApi>`, and signing uses native Kit transactions. Install
Kit explicitly if your app imports it. Lower-level PDA derivation and journal
validation are asynchronous; see the migration guide before upgrading.

The SDK is [MIT licensed](LICENSE). Its dependencies retain their own licenses.

| Import | Purpose |
|---|---|
| `@zkapi/solana-sdk` | `createZkApiClient`, `ZkApiClient`, application types |
| `@zkapi/solana-sdk/browser` | Browser factory, durable custody, Wallet Standard adapter |
| `@zkapi/solana-sdk/deployment` | Download and verify an independently pinned public artifact bundle |
| `@zkapi/solana-sdk/public-profile` | Authenticate a versioned deployment profile and run read-only preflight |
| `@zkapi/solana-sdk/chat` | Bounded text and streaming response readers |
| `@zkapi/solana-sdk/prover-worker` | Entry point to bundle as a module Worker |
| Existing subpaths (`./wallet`, `./control`, etc.) | Advanced integration; preserved |

The factory validates independent deployment pins, artifact hashes, RPC genesis
and finalized PoolConfig. It does not connect a wallet, initialize a deposit,
recover a pending AUTH or send inference. Model tariffs must match the pinned
deployment; model configuration is not proof of live provider compatibility.

Use one stable local note ID and the same browser origin/storage. Consume or
cancel every response. New inference is blocked while recovery, a wallet
operation or permanent clearance remains unresolved. An active direct lease can
serve further explicit requests in its owning client and conversation. Recovery uses
saved authorization and journal state; inference is never automatically replayed.

The source application API reuses direct leases (300-second TTL, renewal when
90 seconds or less remain), matching the Ethereum browser SDK. Set `sessionId`
on each request to scope reuse to a conversation; omission means `default`.
Successful response consumption releases the request without closing the key.
Expiry, explicit `settle()`, cancellation or failure retires it. Set
`keyReuseSeconds: 0` to retain per-request settlement. Proxy defaults to that
per-request policy. The advanced clientd default remains a fixed 60-second window.
This policy is included in SDK `.6`; immutable `.3` artifacts retain their original behavior.

A signature-verified quote issued up to five seconds ahead of the local clock
can wait once for that clock to catch up. The original time and expiry checks
still apply afterward. Larger clock differences, cancellation and a clock that
does not catch up are rejected; no quote or inference request is resent.

## Single-signature deposit

Compact-enabled, independently pinned deployments use the same one-signature
deposit path through the application API. Older deployments keep buffer uploads.

Protocol integration details, custody boundaries, single-signature deposits and
the original transport contract are preserved in [INTERNALS.md](INTERNALS.md).
Public compact-deposit/Phantom acceptance and release readiness remain separate
from local SDK tests. See [status](../../docs/sdk/status.md).
