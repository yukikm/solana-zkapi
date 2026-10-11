# SDK/native 0.2.0-devnet.13

This Devnet prerelease adds registered JSON APIs and a finite HTTP gateway to
the existing wallet, encrypted journal, authorization and settlement lifecycle.
Use the [installation and upgrade guide](../getting-started/gateway-release-upgrade.md).

## Gateway behavior

- Version 2 API bindings and version 3 tariffs, receipts and profiles authenticate
  bounded methods, paths, queries, headers, bodies, trailers and usage meters.
- `fixed_http`, `openai_responses` and `anthropic_messages` use integer accounting,
  durable reservations, exact signed receipt bytes and sign-once settlement.
- Native gateway completion waits for the final local HTTP write. Failed or
  uncertain delivery retains recovery state and never silently retries upstream.
- Registration rejects incompatible reservation caps and contradictory headers.
  Request framing, informational responses, stored Responses prompts and nested
  cumulative Messages usage are validated before their results can be accepted.
- Concurrent journal reads tolerate a legitimate commit while still rejecting
  rollback and divergent authenticated checkpoints.

Direct Chat streaming and authorization recovery improvements from `.10`/`.12`
are retained. See the [finite HTTP contract](../specs/universal-api-gateway-contract.md)
and [integration guide](../getting-started/finite-http-api.md) for exact bounds.

## Compatibility and deployment

For legacy schema 1 only, the SDK accepts profiles listing `.8`, `.9`, `.10`,
`.11`, `.12` or `.13` without changing their bytes, hash or custody namespace.
Schema 2/3 selections must explicitly list `.13`. Existing funded selections do
not gain gateway capabilities through a client update.

Existing `clientd serve` runtime configuration files remain accepted with
permissions such as `0600` or `0644`. These files contain public configuration;
group/other writes remain prohibited, and secret files still require owner-only
permissions.

Operators must deploy matching control and signer binaries and the additive
`0004_finite_http.sql` migration. Follow the [server upgrade procedure](../getting-started/gateway-release-upgrade.md#update-an-existing-control-service).
The current public Devnet selection remains direct OpenRouter Chat Completions;
no public finite HTTP provider is enabled by this release. New integrations need
their own reviewed provider configuration, tariff, frontend routes and profile.
The on-chain program, cryptographic setup and funded identities are unchanged.

## Distribution and evidence

The [immutable GitHub release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.13)
contains the SDK tarball, macOS ARM64 native archive, source archive, checksums
and release manifest. Native support requires macOS 13.5 or newer and is not
Apple signed or notarized. npm registry publication remains disabled.

Review validation covers SDK fixtures, isolated tarball installation, native
Go race tests, Rust contracts/carrier tests and installed gateway lifecycles.
The latter use real local proofs, a separate signer/dispatcher and Vault SBF;
provider and RPC-finality inputs are synthetic. They cover success, HTTP error,
truncation, lost delivery and upstream timeout with conservation and no duplicate
dispatch. Source, installed-package and hosted CI evidence are separate; the
release body records the final counts and CI links.

No fresh paid inference or public-chain wallet transaction is part of release validation.
Public provider coverage, funded browser acceptance, mainnet, production,
security audit and long-term availability remain unverified. Consult
[support](../support.md) and fresh read-only preflight before use.
