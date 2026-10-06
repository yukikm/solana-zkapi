# I10 parity: isolated experimental public-devnet profiles

This change prepares a fresh public-devnet deployment with independently pinned
public artifacts and fresh role keys. It does not deploy a program, initialize a
pool, spend SOL/USDC, invoke a provider, or migrate an existing journal. Historical
fixture deployments, manifests and acceptance reports retain their original
identities. Mainnet and third-party audit acceptance are outside this evidence.

## Trust boundary

The historical devnet fixture uses deterministic tree setup and public fixture
signing keys. It remains usable only through the explicitly selected legacy
fixture workflow. A new public profile must use the separate profile generator,
OS-random single-party tree setup, fresh role keys and a new program/pool.

`setup_profile` remains `test_only`; setup transcripts remain null. The separate
`tree_setup: single_party_os_random` provenance field does **not** claim a ceremony,
independent audit, verified entropy destruction or production eligibility. The
original request/withdrawal circuit artifacts still have upstream single-party
setup assumptions. USDC issuer controls, program upgrade authority, service
availability and the existing settlement/escape trust assumptions also remain.

## Implemented integration

- `scripts/i10_public_devnet_profile.ts` authenticates `public-profile.json`
  against an independently supplied SHA256 before reading the fixed public
  artifact set. It checks profile/hash consistency, unchanged upstream pins,
  fresh tree digests, separate role keys and known fixture-key rejection. It
  never reads the private role seeds, an RPC credential or a wallet.
- `run_i10_devnet_vault.ts` accepts `--public-devnet-profile DIR` with
  `--public-devnet-profile-sha256 SHA`. Public state is isolated below
  `DIR/deployment`, with separate `zkapi_vault.so`, compiler IDL, program keypair,
  deployment record, manifests and pool journals. Existing build/manifest
  identity cannot be overwritten with a changed public profile. The launcher
  also provides `--validate-public-profile`, which stops before RPC/key access.
- Public builds use a schema 2 build manifest containing `public_profile_sha256`
  and `tree_setup`. The public manifest binds the profile bytes in
  `artifact_digests.public_devnet_profile`. The launcher uses the new profile's
  proving keys and verifier constants; it does not substitute the old tree key.
- Control and challenger share `DevnetConfig` validation. Public mode requires
  both `public_profile_file` and `trusted_public_profile_hash`, an independently
  pinned schema 2 build manifest, exact manifest role/circuit matches and matching
  IDL/program artifacts. An omitted pin, schema downgrade, fixture role key,
  fixture tree digest, invalid Baby-JubJub point or synthetic local adapter is
  rejected. `TrustedPool` retains the authenticated public-profile hash.
- Legacy schema 1 configurations retain their exact embedded fixture pins and
  omit the new optional fields. They cannot reinterpret a public manifest as a
  fixture deployment. Running the historical launcher now requires
  `--allow-legacy-devnet-fixtures`; this is deliberately incompatible with the
  public-profile flags.

The generator and Vault build loader are implemented alongside this integration
in `prepare_public_devnet_profile.py`, `public_devnet_profile.py`, the
`public_devnet_setup` example, and the Vault build script. The backend uses the
same explicit public-profile pair and separate deployment path. Source artifact
validation does not replace matching the deployed ProgramData bytes and upgrade
authority; the launcher's existing finalized checks are retained.

## Offline checks

- `node --test scripts/i10_public_devnet_profile.test.ts`: 5 tests passed, zero skipped.
  Cases cover the full launcher offline path without RPC/wallet configuration,
  fresh SDK-manifest bootstrap without historical I05 state, paired independent
  pins, historical-directory isolation, complete
  artifact-byte validation, post-install artifact replacement, fixture role/tree
  material, false ceremony claims, shared roles and artifact binding changes.
  These tests intentionally use synthetic tree bytes; they are configuration
  boundary tests, not setup or SBF proof acceptance.
- TypeScript checking of the public-profile helper and Vault launcher passed:
  `tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext
  --allowImportingTsExtensions --skipLibCheck --esModuleInterop
  scripts/i10_public_devnet_profile.ts scripts/run_i10_devnet_vault.ts`.
- The real newly generated profile also passed the launcher's offline check:
  `target/public-devnet/parity-20261006/public-profile.json`, SHA256
  `3546c78a8c24070d25c70f431839c02b2fbbe36e4eb98f5d2863478cbcc28a45`,
  circuit profile
  `54a77420d689f20ce0ee617f691a408a109d5d9f0923b05f5df129237adf56ed`.
  This verification read only public artifacts; it did not read the new private
  role seeds or any existing wallet/provider secret.
- Focused Rust `devnet_config` validation passed 9 tests, including the final
  startup signer check; its existing disposable PostgreSQL test remained ignored.
  This is offline configuration validation, not a PostgreSQL, SBF or public
  deployment acceptance result.

The managed sandbox requires the network permission profile for child-process
plumbing, even for these offline Node/Rust checks. Without it, a trivial spawned
Node process returned empty output; rerunning with the working process profile
produced the expected output. None of the public-profile tests makes a network
request.

## Preparation workflow

1. Generate into a **new** directory with
   `python3 scripts/prepare_public_devnet_profile.py --output target/public-devnet/NAME`.
   Keep its private seed directory owner-only and outside distributable artifacts.
2. Independently retain/review the `public-profile.json` SHA256. Pass that digest
   with the explicit public-profile directory to the launcher, Vault build and
   backend. Do not obtain the trust pin from an unauthenticated remote manifest.
3. Run the launcher with the profile pair and `--validate-public-profile` for an
   offline artifact check. This action does not read a wallet or reach devnet.
4. When separately authorized to prepare/deploy, use the same pair with
   `--prepare`, retain its generated public build environment, build the exact
   program and IDL into `DIR/deployment`, then perform existing deployment,
   initialization and acceptance steps. The new backend requires
   `--deployment DIR/deployment` (or the selected pool subdirectory) and
   `--program DIR/deployment/zkapi_vault.so`, plus the public-profile pair.

A new deployment does not authorize replay of an old uncertain AUTH, inference
or signed transaction. Recover historical funds using their original fixture
profile, program, pool, manifest and journal; never copy those identities into
this workflow.
