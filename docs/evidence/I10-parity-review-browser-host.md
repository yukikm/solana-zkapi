# Standalone browser chat host follow-up

Date: 2026-10-07. This is local implementation and regression evidence, not a third-party audit or a new live wallet/provider acceptance result. The host addresses the missing connection between the standalone application and an explicitly reviewed public devnet profile. Public deployment packaging and browser acceptance are recorded separately by the parent review.

The new `scripts/browser_chat_devnet_host.ts` consumes a private, owner-only configuration and independently pinned public profile. It authenticates the manifest, public build bytes, proving artifacts and WASM before serving them. Authenticated static bytes remain in memory rather than being re-read after their digests are checked; stray legacy presentation files are not served by the standalone host. The public bundle contains logical transport origins; private RPC URLs and provider management credentials are not public assets.

The numeric-loopback host reuses the existing wallet relay's Host/Origin, read/write, devnet, transaction signature, program, pool and fee guards. A standalone-only control extension admits exact native control routes, common snapshot routes and existing bounded financial preparation paths. Its native forwarding preserves the manifest's logical control Host, enforces response size/time bounds, follows no redirect and retries no write. Direct OpenRouter inference remains browser-to-provider; `/inference` has no standalone relay.

Before forwarding direct AUTH, the host checks the exact schema, token hash, signed quote, configured deployment/mode/tariff, SDK 60-second session TTL, maximum 1,000,000-micro-USDC cap and proof representation. The actual proof remains verified by the SDK and backend. It then reserves the complete lease cap in the existing parent budget, binding the request UUID to SHA-256 of the exact AUTH bytes. An identical uncertain AUTH recovery can reuse that reservation; changed bytes or template cannot. No reservation grants inference replay. The host cannot independently attest the model, prompt or number of direct inference packets because those do not traverse it.

`GET /provider-budget` returns totals and transaction enablement only. It is a read-only availability hint; reservation is the send authority. Exhaustion does not gate close, session recovery or withdrawal clearance. The previous fixed OpenAI wallet host now uses the compatible budget helper so new direct-demo rows remain counted alongside all historical reservations.

Validation commands:

```sh
target/i08-toolchain/bin/node --test scripts/browser_chat_devnet_host.test.ts scripts/i10-wallet-ui/host.test.ts
target/i08-toolchain/bin/node node_modules/typescript/bin/tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --skipLibCheck scripts/browser_chat_devnet_host.ts scripts/browser_chat_devnet_host.test.ts scripts/i10-wallet-ui/host.ts scripts/i10-wallet-ui/host.test.ts
```

Both commands passed. The recorded test run passed 26 tests with zero skips in 1.445 seconds, including seven standalone cases and 19 existing wallet host cases. [Machine-readable results](I10-parity-review-browser-host-results.json) record the command, output and seven unchanged source hashes. Tests use actual numeric-loopback HTTP listeners and temporary budget ledgers; they do not read or modify funded journals, live campaign state, credentials, public chain state or provider accounts. Coverage includes admission before forwarding, exact retry identity, altered quote/token/proof rejection, no inference relay, logical Host remapping, bounded/redacted responses, pinned bytes, origin/header/write guards, mixed historical/direct budget rows, exhausted capacity and continued close/clearance access.

An independent read-only review of `provider_demo_budget.py`, `provider_demo_budget.ts` and the recovery compatibility change found no additional actionable issue in lock ownership, full-cap accounting, cross-kind UUID collision checks, exact-AUTH re-fsync, or preservation of original campaign selection checks. Runtime evidence from those modules remains in their separate tests.

The standalone UI reviewer independently inspected the control admission, configured host, public budget projection and native forwarding and found no additional actionable issue. The earlier run before excluding stray legacy presentation files is preserved in `I10-parity-review-browser-host-initial-results.json`.
