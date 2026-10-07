# Installed complete-bundle proof acceptance

Recorded 2026-10-07 JST. An independently installed `@zkapi/solana-sdk@0.2.0-devnet.2` generated six fresh Groth16 proofs from the supplied schema-2 bundle: native and WASM request, escape-withdrawal and tree-insert proofs. A separate native verifier accepted all six using the exact verification-key bytes from that bundle. Eighteen negative checks passed. The supervised command exited 0 in 43.026 seconds.

The [machine-readable evidence](PD-complete-bundle-proofs.json) retains the original result, individual proof hashes, public-input counts, verification-key hashes, timings, ten authenticated notices and exact source/artifact hashes. The initial result and public proof bytes remain unchanged at `target/public-devnet-followup-20261007/bundle-proofs-initial/`. No proof witness or credential was saved.

| Engine | Circuit | Public inputs | Proof bytes | Independent verification | Negative checks |
|---|---|---:|---:|---|---:|
| Native | Tree insert | 11 | 256 | Passed | 3 |
| Native | Request | 12 | 256 | Passed | 3 |
| Native | Escape withdrawal | 14 | 256 | Passed | 3 |
| WASM | Tree insert | 11 | 256 | Passed | 3 |
| WASM | Request | 12 | 256 | Passed | 3 |
| WASM | Escape withdrawal | 14 | 256 | Passed | 3 |

Each proof rejects a zeroed proof encoding, a changed first public input and a mismatched verification-key SHA-256 pin. The last check validates key identity; it does not test a different valid verification key against the pairing equation. Native and WASM tree/withdrawal public inputs agree, as do the first ten request public inputs; the final two request inputs are fresh rerandomization points.

## Exact artifacts

| Input | SHA-256 |
|---|---|
| Installed SDK tarball | `fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc` |
| Installed SDK file-map digest | `18a6a7579c9c1191aa0f864edb52ad6d323e751d35b68f4cbe786bef79695f08` |
| Complete bundle descriptor | `4169846c4a8a02162ca4870ff069e86e94aa06064d67d17ce39e8f344bc1a423` |
| Native prover | `e0f6891e4320040db6f54e03eb03b11f5de194a42ddd477ab26dd376c42df8d6` |
| Bundle WASM | `c06a247e1ff88f1ac415ea127bcf49d486b5b4954715cdf00f133b5ac71c1f30` |
| Independent verifier binary | `3315290a1c27a2ec7c38dda2661d3db6d572e0ab807c6dc3b4666cb2987906de` |
| Acceptance script | `045be08887994dba46728452e30df9df6bd77e45eabd78d44c5fc86b0a22dfce` |
| Independent verifier source | `bbc39295b49fdfcd99af5b4d2145cc68119f2278f41e7b902043f6e6f95d9aec` |
| Original result | `e6e2ac53f84ab0298ec5ca10fc5b22dc58c218af7b9f9d60c21e05c2e1e1179c` |
| Saved public proofs | `afda69cef947ca413ffc4e12f9c71c560d1d01dd72da9210308891263fda68fc` |

The SDK was installed in an independent temporary `node_modules` directory. Its declared exports supplied every SDK import; workspace SDK source imports and symlinked package files are rejected. Its file-map digest hashes the JSON encoding of the sorted relative-file-to-SHA-256 map. The SDK and all supplied bundle files were checked unchanged after the run. Bundle packaging, notice review and preservation of the 15 original payloads are recorded separately in [complete bundle notices](PD-complete-bundle-notices.md).

## Reproduction and limits

Build [the independent verifier](../../crates/zkapi-tree-prover/examples/verify_public_bundle.rs) with `cargo build --release --locked -p zkapi-tree-prover --example verify_public_bundle`. Run [the acceptance script](../../scripts/verify_installed_bundle_proofs.mjs) with a local configuration and a new output directory:

```sh
node scripts/verify_installed_bundle_proofs.mjs CONFIG.json NEW_OUTPUT_DIRECTORY
```

The configuration pins the installed SDK directory and file-map digest, bundle directory and descriptor digest, native prover path/digest and independent verifier path/digest. `node scripts/verify_installed_bundle_proofs.mjs --sdk-tree-hash INSTALLED_SDK_DIRECTORY` computes the package digest. The original configuration is retained under `target/public-devnet-followup-20261007/proof-acceptance-config.json`; a reproduction needs its own reviewed local paths and binary hashes. Existing outputs are never overwritten.

The verifier receives only public inputs, proof bytes and supplied verification keys. It validates canonical field encodings, circuit arity, exact key digest/decoding and the Groth16 equation. It has no proving key, provider connection or transaction state. The script disables external fetch and loads authenticated bundle files through a bounded local adapter.

WASM ran in Node, not Chrome. The genesis note was unfunded. The quote was synthetic and unsigned, and the withdrawal used escape mode without mutual-close clearance. RPC, provider, AUTH, funding and transaction actions were all zero. This establishes actual proof generation and verification from this bundle, beyond the older snapshot-path reconstruction and WASM initialization checks. It does not establish public downloads/TLS/CORS, browser execution, a deployed operator, provider acceptance, settlement, a funded lifecycle or complete release gates. The bundle retains historical manifest origins and must not be presented as the new public deployment profile. Earlier immutable releases and evidence remain unchanged.
