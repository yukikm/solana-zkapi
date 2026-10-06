# I10 parity dependency review

Checked against the public npm and crates.io registries and official upstream
releases on 2026-10-06 JST. This is a compatibility update for the existing
proof, transaction and recovery implementation. It is not a claim that every
dependency uses the newest major version, or new public-devnet acceptance.

## Version decisions

| Component | Registry/upstream current release | Decision |
| --- | --- | --- |
| `@solana/web3.js` | npm `latest` 1.99.0, published 2026-09-08; `next` 3.0.1 | Upgrade 1.98.4 to 1.99.0, retain the existing transaction/journal APIs. |
| `@solana/kit` | 8.4.0, published 2026-09-28 | No migration in this patch; replacing the transport and transaction types requires a separate wire-equivalence review. |
| `@wallet-standard/app`, `@wallet-standard/features` | 1.1.1 | Already pinned to the current release in the browser acceptance app. |
| Solana Wallet Standard features/util | 1.5.0 / 1.2.0 | These packages are not dependencies of this implementation; do not add unused packages merely to claim currency. |
| `anchor-lang`, `anchor-spl` | 1.2.0; maintained 0.31 branch backport 0.31.2 published 2026-09-14 | Upgrade the existing 0.31.1 Rust stack to 0.31.2, including IDL and SVM consumers. The 0.31.2 release retains `solana-program = "2"`. |
| `solana-program` | 5.1.0; latest 2.x is 2.3.0 | Upgrade 2.2.1 to 2.3.0 together with its compatible SVM harness. |
| `solana-sdk`, `solana-pubkey` | 5.0.0 / 4.4.0 | Upgrade the SVM SDK from 2.2.1 to current 2.x 2.3.1 and host PDA/pubkey helpers to latest 2.x 2.4.0. No cross-major type migration. |
| `groth16-solana` | 0.2.0 | Already current. Preserve BN254, proof encoding, public-input ordering and existing verifying-key semantics. |
| `anchor-lang-idl` | 0.2.0 | Retain 0.1.4, matching the 0.31 Anchor line and compiler-backed IDL flow. |
| LiteSVM / `solana-compute-budget` | 0.17.0 / 4.3.0 | Upgrade 0.6.1 to 0.7.1, the last LiteSVM line using Solana 2.3, with compute-budget 2.3.13. Fresh runtime evidence is required; historical reports retain their original versions. |
| Agave | 4.3.0, stable for Testnet/Devnet/Mainnet Beta | Deployment/validator tooling is separate from the on-chain program crate version. No validator is installed or upgraded by this patch. |
| `cargo-build-sbf` / platform-tools | 4.4.0 / v1.57 (Rust 1.95.0, LLVM 22) | Preserve the recorded 4.1.0/v1.54 acceptance toolchain and explicit `--arch v0`. The newest builder defaults to SBPFv3; silently changing that output would invalidate the established SBF measurements. |
| Host Rust | Project pin 1.90.0 | Retain the deterministic project toolchain. Host Rust and the SBF compiler are separate. |

`@solana/web3.js` 1.x is now explicitly described upstream as receiving critical
fixes only. Calling it the actively developed modern SDK would be inaccurate.
Version 1.99.0 is nevertheless the current npm `latest` release and the compatible
update for this existing application. Its official release adds v1 transaction
read support; it does not require changing the application's signed v0 sends,
Wallet Standard signing requests, persistent journals or uncertain-send rules.
The lockfile includes the release's updated Solana codec dependencies.

The Anchor 0.31.2 changelog does not enumerate a Rust security fix. The update is
to the latest published compatibility branch, not a claim that an independently
validated vulnerability was remediated. The new build dependencies used to
validate public-devnet proof artifacts stay on the existing Arkworks 0.5 and
SHA-256 0.10.9 families; this does not replace the cryptography.

## Coordinated Solana 2.3 compatibility update

The first trial changed `solana-program` to exact 2.3.0 and attempted to resolve the
same `tests/svm` acceptance graph. Resolution failed: program 2.3.0 requires
`solana-instruction ^2.3.0`, whereas the current LiteSVM runtime
`solana-program-runtime 2.2.0` requires `solana-instruction =2.2.1`. Allowing
runtime 2.2.1 additionally conflicts with the fixture's exact
`solana-compute-budget =2.2.0` pin. Updating only the program dependency is
therefore insufficient.

Official crate manifests show LiteSVM 0.7.1 depends on Solana 2.3, while LiteSVM
0.8 starts the Solana 3.x family. Updating the existing harness to LiteSVM 0.7.1,
Solana SDK 2.3.1 and compute-budget 2.3.13 resolves the graph while retaining
the 2.x account/instruction types. The same coordinated pins are used in the
key-validation diagnostic harness. Cargo lockfiles are regenerated through
Cargo, including transitive runtime dependencies, without changing proof keys.
The first compile retained an older transitive `solana-keypair 2.2.1` lacking
`TryFrom<&[u8]>` used by LiteSVM 0.7.1. Updating both harness locks to the
compatible current 2.x keypair 2.2.3 resolves that API requirement.

Moving to current Anchor/Solana/LiteSVM major versions requires coordinating
account and instruction types, SPL interfaces, IDL generation and runtime
features, then rerunning the actual SBF proof/withdrawal/challenge matrix and
comparing compute limits and transaction bytes. No historical fixture result
is evidence for such a migration. No provider inference, transaction signing,
funded state, published manifest or recovery journal was touched by the
dependency update.

## Sources

- npm metadata: [web3.js](https://registry.npmjs.org/@solana%2fweb3.js),
  [Kit](https://registry.npmjs.org/@solana%2fkit),
  [Wallet Standard app](https://registry.npmjs.org/@wallet-standard%2fapp),
  [features](https://registry.npmjs.org/@wallet-standard%2ffeatures),
  [Solana features](https://registry.npmjs.org/@solana%2fwallet-standard-features),
  [Solana util](https://registry.npmjs.org/@solana%2fwallet-standard-util).
- [web3.js 1.99.0 release](https://github.com/solana-foundation/solana-web3.js/releases/tag/v1.99.0)
  and [upstream maintenance policy](https://github.com/solana-foundation/solana-web3.js/blob/main/README.md).
- [Anchor 0.31.2 release](https://github.com/otter-sec/anchor/releases/tag/v0.31.2),
  [version-pinned dependency manifest](https://github.com/otter-sec/anchor/blob/v0.31.2/lang/Cargo.toml),
  [1.2.0 release](https://github.com/otter-sec/anchor/releases/tag/v1.2.0).
- crates.io metadata: [Anchor](https://crates.io/api/v1/crates/anchor-lang),
  [Solana program](https://crates.io/api/v1/crates/solana-program),
  [Solana SDK](https://crates.io/api/v1/crates/solana-sdk),
  [Solana pubkey](https://crates.io/api/v1/crates/solana-pubkey),
  [Groth16](https://crates.io/api/v1/crates/groth16-solana),
  [LiteSVM](https://crates.io/api/v1/crates/litesvm),
  [Anchor IDL](https://crates.io/api/v1/crates/anchor-lang-idl).
- [Agave v4.3.0](https://github.com/anza-xyz/agave/releases/tag/v4.3.0),
  [cargo-build-sbf v4.4.0](https://github.com/anza-xyz/cargo-build-sbf/releases/tag/cargo-build-sbf%40v4.4.0),
  [platform-tools v1.57](https://github.com/anza-xyz/platform-tools/releases/tag/v1.57).

## Validation

The validation record below distinguishes dependency checks from the broader
parity changes being made concurrently. Full SDK/SBF acceptance and public
provider acceptance are separate results.

- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` and
  `npm ci --ignore-scripts --no-audit --no-fund`: passed with the updated lock.
- `npm run typecheck` and `npm run typecheck:examples`: passed with web3.js 1.99.0.
- Initial `npm test`: 230 passed, six failed because the existing generated
  `target/i05/public-manifest.json` fixture was absent, and one browser child
  was cancelled after it stalled. This initial attempt is not a suite pass;
  the clean-checkout prerequisite fix and final full-suite result are recorded
  separately in [`I10-parity.md`](I10-parity.md).
- `cargo check --locked --manifest-path programs/zkapi-vault/Cargo.toml`: passed
  with Anchor 0.31.2 and Solana-program 2.3.0, including the public-devnet profile
  build validator. An initial check identified a missing Arkworks `curve`
  feature in the new host build dependency; enabling that existing feature fixed it.
- `cargo check --locked --manifest-path tests/svm/Cargo.toml --all-targets`:
  passed with LiteSVM 0.7.1 and its Solana 2.3 runtime. The changed
  `add_program` API now returns a result; fixture loading explicitly checks it.
- Separate locked checks of `tests/key-validation-diagnostic/host`, its
  `program`, `programs/i02-harness` and `programs/i02-layout2`: passed. The first
  diagnostic check stopped while downloading uncached crates because that
  command lacked network access; the network-enabled retry passed.
- `cargo test --locked --manifest-path programs/zkapi-vault/Cargo.toml --lib`:
  nine passed.
- Focused SDK encoding, transport and Wallet Standard tests: 28 passed,
  zero failed/skipped (`node --experimental-strip-types --test
  --test-isolation=none --test-reporter=tap` with the three corresponding
  `packages/sdk/test/*.test.ts` files).
- Compiler-backed IDL generation with `tools/vault-idl`: passed. Output is
  byte-identical to `docs/contracts/zkapi_vault.json`, SHA-256
  `0759025148be84d67f95e71ca79057d249a5de3f2574e972ce3295aac530a671`.
- Actual compact-deposit SBF execution: 61 cases passed, maximum 179,147 CU.
  The SDK-generated signed v0 wire remains 1,007 bytes and one signing request;
  the actual SDK compact deposit consumed 178,542 CU. The archive slots in this
  local harness are synthetic, not public finality receipts.
- Actual legacy Vault SBF execution: 366 transactions, 203 successful and 163
  expected rejections, maximum 426,839 CU and 863 transaction bytes. This
  includes proof, wrong-VK, withdrawal and challenge checks. This particular
  harness uses the existing sealed-buffer fixture boundary; it does not claim
  a new complete I04 buffer-lifecycle acceptance run.

The raw local SBF reports and an artifact/command summary are saved in
[`I10-parity-dependencies-components/`](I10-parity-dependencies-components/).
Their scope is the updated dependency graph and local real-proof runtime.
The fresh public profile's separate SBF acceptance is recorded by
[`I10-parity-public-profile.md`](I10-parity-public-profile.md) and
[`I10-parity-public-devnet-svm-results.json`](I10-parity-public-devnet-svm-results.json):
eight actual SBF cases passed, including initialization with fresh role keys,
a proof generated with the new tree setup, compact deposit/expiry token CPIs,
and rejection of fixture/swapped keys, the old setup proof and early expiry.
Maximum consumption was 205,191 CU / 1,202 transaction bytes. This is local
execution of the public-profile ELF, not a public network deployment.

## SBF build reproduction and artifacts

The official platform-tools v1.54 Linux archive was downloaded from
<https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2>
and its SHA-256 verified as
`fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e`.
The compiler is Rust 1.89.0 / LLVM 20. All builds used explicit `--arch v0`.

The build tool was installed from `cargo-build-sbf =4.1.0` using its locked
dependencies. Its cache implementation only accepts the home directory by
default. To keep all tools within the writable workspace, a local copy of the
installed builder source was changed to consult `ZKAPI_SBF_TOOLCHAIN_HOME`
before falling back to `HOME`, then rebuilt. This is a cache-location-only
tooling change; the SBF compiler/platform-tools and repository source were not
patched for this environment. `ZKAPI_SBF_TOOLCHAIN_HOME` pointed to
`/workspace/work/toolchains/sbf-cache`, whose expected v1.54 cache path links
to the verified extracted archive. No home-directory files were written.

The common build command was:

```sh
cargo-build-sbf --manifest-path programs/zkapi-vault/Cargo.toml \
  --tools-version v1.54 --skip-tools-install --arch v0 \
  --features sbf-entrypoint --sbf-out-dir "$OUTPUT" -- --locked
```

| Build | Bytes | ELF SHA-256 |
| --- | ---: | --- |
| Local test | 379,800 | `906110e3aba857ddb0dd3063c127a330220505f3fb6cee3f32ce443a1ebe190d` |
| Local test, `sbf-entrypoint,wrong-vk` | 381,216 | `d76e137faf3b60cdae9a4d3561de18230896c1c12387222852b5280d4f7db768` |
| Fresh public profile, synthetic compilation initializer | 380,728 | `44101e7b898d66b1ecfafaaea67b674d4e20149dfa472257192adad03c239515` |
| Fresh public profile, local SVM signer initializer | 380,760 | `e7fb90c69a845172b441b9b7e75473c234b9aaf0ef2405c8101bb269fab9d5a9` |

Both public-profile builds use `--no-default-features --features
devnet,sbf-entrypoint`, the separately generated manifest digest
`3546c78a8c24070d25c70f431839c02b2fbbe36e4eb98f5d2863478cbcc28a45`
and synthetic program ID `9ZKaPRLwKibNaMpsz46iC7bpHQ9RoHsBbRuBFTBaHSp2`.
The first initializer is
`8qbHbw2BbbTHBW1sbeqakYXV5RKr6cF9sXByS3DxqroS`; the local SVM build uses
`AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9`, a known local test signer,
so the runtime can enforce real transaction signatures. These identifiers
are compilation/test inputs, not a deployed program or newly funded wallet.
The four outputs were saved separately from every historical deployment ELF.
An earlier local SVM build used an incorrectly calculated test initializer
(`nHSjCbSd3XD3UwGy5uAAUqEfDf4kBDYaJZ4eF82nCDZ`); the harness rejected that
setup before executing a transaction. Its ELF digest was
`a3c6689dae6d20f3c9647e1e45e4c140609b342f78546f2ee4ffa058692fa4fd`.
The corrected build above uses the public key actually derived by the fixture.

No provider request, on-chain deployment, funded state migration or historical
journal rewrite was performed to validate this dependency update. Current
major-version migrations and latest SBF compiler validation remain distinct
future changes; this report does not describe the whole stack as latest-major.
