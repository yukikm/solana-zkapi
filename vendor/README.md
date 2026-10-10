# Ethereum zkAPI source pin

`ethereum-zkapi/` is an unmodified Git submodule at
`045b444ea1b52538d1b40273c7cb6ed09468a052`. Initialize it with
`git submodule update --init --recursive` and run `python3 scripts/check_upstream.py`
from the repository root before using its circuits or setup files.

All original source notices and license files remain in the submodule. The Rust
workspace declares `MIT OR Apache-2.0`; the clientd MIT notice credits the
Open Anonymity Team. The pinned tree has no root LICENSE file; do not fabricate
one or describe the clientd license as the license of every bundled dependency.
Dependency notices also remain under their original paths.

[upstream-lock.json](upstream-lock.json) is the single source for the upstream
commit and SHA-256 pins for source, setup, dependency lockfiles and license
evidence. The checker verifies the Git submodule commit and file hashes, then
compares the proving keys with the configuration in that same pinned source.
These are upstream single-party test setup artifacts, not a production ceremony.

Intentional differences live outside this directory: Solana H2F bindings,
micro-USDC integer accounting and the Groth16 wire adapter. Circuit constraints,
Poseidon domains/parameters and state signatures are unchanged. Wallet, prover,
session and application APIs are implemented outside the upstream submodule;
see the [SDK guide](../docs/sdk/README.md) for their current verification limits.
No Ethereum native-asset deployment configuration is reused as a Solana
production configuration.
