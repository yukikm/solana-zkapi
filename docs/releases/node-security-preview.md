# SDK/native 0.2.0-devnet.14

This Devnet security update pins Node.js 24.22.1 LTS, npm 11.19.1 and
`@types/node` 24.19.2. It retains the existing wallet, encrypted journal,
authorization and settlement lifecycle. Follow the
[installation and upgrade procedure](../getting-started/node-security-upgrade.md).

This release uses separate SDK and native archives. Authenticate the
[GitHub release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.14),
its release manifest and asset attestations before installing. Existing
published `.13` assets remain immutable.

## Security changes

Node 24.22.1 fixes the October 21, 2026 security advisories, including the
Brotli decoder out-of-bounds write that permits remote code execution
(CVE-2026-111497), DNS input validation and TLS hostname validation issues.
It also updates bundled Undici to 7.30.1, OpenSSL to 3.5.9 and c-ares to 1.34.9.
See the [Node.js security announcement](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
and [24.22.1 release notes](https://nodejs.org/en/blog/release/v24.22.1).

Node 24 remains the supported LTS series for this package. npm 11.19.1 is the
version bundled with this Node release. `@types/node` is a development dependency;
production npm dependency versions remain unchanged, including `@solana/kit`
8.4.0. The reviewed production dependency graph reports zero known npm audit
vulnerabilities. npm audit does not cover Node's bundled native libraries or
establish that the application is free of vulnerabilities.

## Compatibility

The SDK accepts authenticated `.13` profiles in schemas 1, 2 and 3, and retains
the previous legacy schema 1 compatibility with `.8` through `.12`. Their exact
bytes, hashes, deployment identities and custody bindings remain unchanged.
Installing `.14` does not add an API capability to an existing selection.
The public Devnet profile remains direct OpenRouter Chat Completions.

The native archive packages the new Node executable in a separate installation.
An existing funded native profile still pins its original runtime; this release
does not migrate or rewrite that binding. Preserve original installations,
profiles, journals, receipts and recovery material. See the upgrade procedure
before selecting an installation.

The on-chain program, Pool, circuits, setup, tariffs and financial state machine
are unchanged. This update does not require a new Pool, database reset, new grant
or capacity reset. Published `.13` SDK/native archives are retained as original
artifacts rather than being rebuilt under their existing names.

## Verification scope

Local verification on Node 24.22.1 passes 554 source SDK tests and 339 tests
against an independently installed SDK tarball, with zero skips in both groups.
Five installed native-profile contract tests also pass. The isolated package
check verifies Node exports, TypeScript declarations, public consumer commands
and browser/worker bundles. Type checking, upstream source provenance, toolchain
selection and consumer lock fixtures pass; npm audit reports zero known
vulnerabilities. These are local fixture and package results, not hosted CI,
real proof/SBF or live provider results.

The release body records any additional native, hosted CI or public read-only
checks separately. Historical `.13` lifecycle results do not automatically
validate the new runtime. A zero-vulnerability npm audit is a dependency
observation, not a security audit or public provider acceptance.

This update does not establish fresh paid inference, public wallet transactions,
funded browser coverage, full provider coverage, mainnet, production readiness
or long-term availability. See [support](../support.md) and fresh read-only
preflight for the deployment's current state.
