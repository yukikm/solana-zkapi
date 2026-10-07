# Complete bundle notices and preservation checkpoint

Recorded 2026-10-07 JST. A new schema-2 bundle was packaged at `target/public-devnet-followup-20261007/notices-bundle/` from the original public input configuration. No network, funding, AUTH or inference was performed. No SDK/runtime source changed during this packaging step. This is local byte identity and distribution-record evidence, not public hosting or proof-generation acceptance.

- Bundle descriptor SHA-256: `4169846c4a8a02162ca4870ff069e86e94aa06064d67d17ce39e8f344bc1a423`
- Descriptor: 6,286 bytes; payloads: 26,762,260 bytes; total public files including descriptor: 26.
- Manifest hash remains `0e003f5d03109870af469e430eb268d160d0098ea114049eb454c039eaca8b7d`. Historical HTTPS loopback control/inference origins remain unchanged; this cannot serve as the new public profile.
- Original schema-1 bundle remains `af5a2eb9e11cf93174d9e1391e523a017f028a1518cd768de102f9e326bde591`. All 15 original payloads are byte-identical, and 15 public source/config files match their before hashes.
- All four setup PK/VK SHA-256 values, byte sizes and Git blob hashes match `deploy/public-devnet/upstream-setup-distribution.json`.
- The exact per-file checker passed, with distribution-review SHA-256 `0f62ef19d5c8dc8791aff7b5faf39bb215b82536d8960552caa6d4b648d58f02`. The checker explicitly does not verify legal sufficiency, publication or proof generation.

The [machine-readable checkpoint](PD-complete-bundle-notices.json) retains the exact descriptor, every public file's review record, notice hashes and the original source inventory. The actual binary and notice files remain in the new local output directory; this checkpoint does not duplicate those payloads. The [upstream decision](../../deploy/public-devnet/upstream-setup-distribution.json) and [redistribution follow-up](PD-02-redistribution-followup.md) establish the separately reviewed four-file scope.

## Authenticated notices

All five requested upstream/provenance documents are present, along with the project's MIT license and matching conservative dependency material. Every notice is authenticated by the descriptor and mandatory for schema-2 loading.

| File | Bytes | SHA-256 |
|---|---:|---|
| Apache-2.0.txt | 10280 | `074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff` |
| BUNDLE-PROVENANCE.md | 2387 | `3904df43cfc4482b1080c6a7d8dd8874a82049494d6df8a2a73c301d88be7cce` |
| PROVENANCE.md | 3682 | `2b2fd1dd5baf7baf8fe0947987c56b8465c64b63e179d461f7a12f190b834aed` |
| Rust-dependencies.json | 232194 | `8ee3fafc6e0c7758c6f5846fb8083852985f326efc3868fbe059b003cfa6d1a5` |
| Rust-notices-1.json | 849885 | `60901baa076fb37f4fd60c337f8feae117b27723ef0194b4a6462d501c198f7d` |
| Rust-notices-2.json | 145787 | `8c7dfd19d3a2433ee81a276153ef487a11ca43b969d455e4b24d309905afb89f` |
| Solana-zkAPI-LICENSE.txt | 1097 | `71afea996cef8ff3d3ef4f84705180bb0b124c1c21a16e89fddacd3b482d4fa7` |
| ethereum-VENDORED-045b444.md | 2208 | `12e597fefcdb430f28a1ca16c1fe917e0bd2513958aa8523e1e1610bb947fce3` |
| mingyech-README-8b2d4e3.md | 3301 | `f93dcf61244ca2c3de783aa68355cb263024f5b5da3ec9fd40ac26cbee157846` |
| mingyech-setup-README-8b2d4e3.md | 894 | `22b8ab79c6e8c985447c2a20b55d9253b5c2dab932cbd50927538f3571ffcf5d` |

The notice material totals 1,251,715 bytes, below the 4-MiB aggregate bound. The largest notice is below 1 MiB. `Rust-dependencies.json` records 301 normal/build dependency packages for the locked `wasm32-unknown-unknown` prover and `sbpfv0-solana-solana` Vault with `sbf-entrypoint`. `Rust-notices-*.json` retain 223 distinct exact UTF-8 texts, coalescing duplicates by SHA-256; reconstruction verified every text's original hash/size and every reference. Declaration-only packages remain explicit, with exact Cargo declarations rather than invented attribution. This is a conservative source/lock closure, not binary-level inclusion or reproduced-build evidence.

The installed WASM compiler supplies its complete standard-library copyright catalog. The installed SBF toolchain omits that catalog; its supplied standard-library source notices and exact core/alloc license declarations are retained instead, clearly identified without fabricating a catalog. The Apache-2.0 option is selected where their declarations permit it. The full standard Apache text is included.

## Reproduction and evidence

`notices-bundle-input.json` points to read-only original artifacts and notice sources. `prepare-notice-inputs.py` records the local dependency notice preparation; `review-notices-bundle.py` validates the old bytes, exact setup decision and coalesced texts. Offline cargo metadata used the installed compiler and locked manifests; an initial metadata probe under the wrong standard compiler could not resolve the SBF target and made no artifact change, then the installed SBF compiler succeeded.

`notices-package-result.json` records the packager result. `notices-package-checks.json` records source and old-bundle preservation. `notices-distribution-review.json` contains a decision for every exact public file, and `notices-release-check.json` is the passing `check_public_bundle_release.py` output. Source URLs identify the authored project, generator/evidence or upstream provenance; they are not a claim that this new bundle is published at those URLs.

Actual installed proof generation from these supplied PK/VK/WASM bytes is recorded separately in [complete bundle proof acceptance](PD-complete-bundle-proofs.md). This packaging checkpoint itself performs no proof generation. The older `--real-provers` external runner stage reconstructs a snapshot path; `--asset-bundle` loads/hashes and initializes WASM. Combining those older stages alone does not establish request/withdrawal/tree proof generation from this bundle.

The immutable `v0.1.0-devnet.1` and `v0.2.0-devnet.1` release assets remain unchanged and continue to omit this complete bundle. No actual browser, public operator, provider, funded lifecycle, new setup ceremony or complete release-gate acceptance follows from this packaging result.
