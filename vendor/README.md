# Upstream dependency

`ethereum-zkapi/` is the unmodified `ethereum/zkapi` submodule at
`045b444ea1b52538d1b40273c7cb6ed09468a052`. It is required to build Solana zkAPI:

- Rust crates import its `zkapi-core`, `zkapi-proof` and `zkapi-types` crates.
- The prover and control service use its request/withdrawal circuits and keys.
- Compatibility tests use its reference contracts and cryptographic fixtures.
- Native release packaging preserves its source and license notices.

Initialize and verify it from the repository root:

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
```

[upstream-lock.json](upstream-lock.json) pins the revision and file hashes.
The setup keys are upstream single-party compatibility artifacts, not a
production setup ceremony. Solana bindings, integer micro-USDC accounting,
transaction transport and application APIs live outside this submodule.

The upstream Rust workspace declares `MIT OR Apache-2.0`. Its clientd MIT notice
credits the Open Anonymity Team. The pinned tree has no root license file;
neither declaration covers every upstream directory. Keep original notices and
see [third-party notices](../THIRD_PARTY_NOTICES.md) for distribution scope.
