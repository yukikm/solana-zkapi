# SDK/native 0.2.0-devnet.7 privacy release

Published **2026-10-09T18:32:01Z** (2026-10-10 JST) as immutable
[`v0.2.0-devnet.7`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.7),
release ID `408219163`, from exact source
`dd9fb409b2f1e52421956262eb88026069ea8c79`, committed and pushed to `main`.
The user requested priority privacy fixes and publication. Work used an isolated
managed checkout; the original working tree and historical custody were preserved.

## Fixed boundaries

The shared direct-request validator now runs at admission and low-level dispatch.
It rejects unknown identity/transport fields, duplicate keys, conflicting provider
preferences and OpenRouter hosted-tool aliases. Direct OpenRouter sends require
`provider: {zdr: true, data_collection: "deny"}`; direct Responses requires
`store: false`. Errors do not trigger a weaker policy or an inference replay.

Direct request text never enters the journal. Proxy text is retained while unsent,
then replaced atomically with a redaction marker and exact-byte fingerprint before
dispatch. Verified settlement covers legacy bodies and matching emergency copies.
The SDK and authenticated native management command can explicitly purge bodies
and fingerprints from settled history. Active requests and unresolved emergency
archives remain intact, as do AUTH, receipts, signatures and financial state.

Legacy raw bodies and their historical fingerprints remain accepted by the
recovery collectors. This does not retroactively assert that old requests used
ZDR. Reading an old journal does not automatically rewrite it. See the
[release guide](../releases/privacy-preview.md) for profile pins, installation,
retention semantics and remaining trust assumptions.

## Distribution and verification

All six release assets were downloaded anonymously and matched their exact
hashes and sizes. GitHub release attestation and all six asset attestations passed;
the signed statement binds the exact source commit and every asset digest.

| Artifact | SHA-256 |
|---|---|
| SDK `.7` | `aa15fc35b72f48fdd4f7b70245092e4372ca98f6829105e197e6792505910612` |
| macOS ARM64 archive | `519bd906d18f46b66541133627a15f6473eca1b46727428033f1eee17604e631` |
| Native `release.json` | `dedf721a33e0f14bb8983400770d3795ce4b8083aa013ec36946a1e7f48ea456` |
| Revision-5 profile | `8c11a03fe09a6fb8c4361d89bfea3fb7a2d831bb5b6f956634bcdd94ad49d703` |

- Local final source tests: **528 passed, zero failures/skips** (407 SDK,
  45 provider collectors, 76 recovery). Typecheck and builds passed.
- Actual release tarball in an independent application: **209 passed, zero
  failures/skips**, including declaration/import and browser bundle checks.
- [Client preview CI](https://github.com/yukikm/solana-zkapi/actions/runs/37972788470):
  both jobs passed at the exact release source, including 407 SDK tests, 209
  installed-package tests, real Chrome, Go race and helper checks. The hosted SDK
  tarball is byte-identical to the released SDK and the native embedded package.
- Local Go race checks passed for three clientd packages. Release-provenance
  tests passed 6 cases; 23 pinned upstream source/setup files matched.
- The extracted native archive's **7,259 files** and **578 source inputs** matched
  the manifest and exact source. All **1,718 source-archive files** match Git.
  The source archive excludes submodule contents; its pinned Ethereum revision is
  `045b444ea1b52538d1b40273c7cb6ed09468a052`.
- Installed native public **ten-check read-only preflight** passed. Independent
  public-input generation produced 21 models, 60-second reuse and a 120-second
  settlement wait, without initializing custody or starting a daemon. All 7,259
  native files remained unchanged afterward.
- [Implementation CI](https://github.com/yukikm/solana-zkapi/actions/runs/37972788480)
  had three successful jobs and six running at the immutable manifest cut; the
  later publication receipt has four successful and five running. Neither cut
  claims an all-nine-job pass.

The [machine-readable receipt](PD-sdk7-publication-20261010.json) includes the
signed statement, downloads, CI cuts, profile preservation and public RPC facts.
Distribution uses GitHub assets, not npm. Native support remains macOS ARM64,
macOS 13.5+, without Apple signing/notarization.

## Compatibility, scope and trust

Revision 5 changes only profile revision and supported SDK version. The 21 models,
deployment, proof artifacts, tariffs and preparation policy are unchanged. Four
older public profiles were fetched and their digests remained unchanged. Existing
custody retains its original runtime, profile, journal and recovery inputs; this
release does not migrate it or change gateway discovery.

There were **zero live AUTH, provider inference, wallet transactions, grant
changes, service restarts or program mutations**. Publication added one immutable
static profile. The existing request grant remains exhausted. Fixtures and
read-only preflight do not establish live ZDR endpoint availability or production
reliability. The routing policy is not cryptographic evidence of deletion and is
not a proxy/OA ZDR claim. External backups and application transcripts remain
outside the purge operation.

Ethereum-equivalent program reliability is not established by common request and
withdrawal proving keys. Solana adds a tree-transition proof and an OS-random
single-party setup marked `test_only`, without a verified ceremony transcript.
Fresh finalized RPC at slot `509266027` confirmed the declared single-key program
upgrade authority remains set, and the USDC mint has issuer/freeze authorities.
The pinned Ethereum Vault uses native ETH and immutable proof/key parameters,
although its owner retains pause and treasury controls. These are different trust
conditions even when mainnet and third-party audit status are excluded.

## Preserved failures and publication correction

Initial preparation observations remain retained: unpinned engine warnings,
typed fetch/test helper corrections, a Go expected-call-count correction, the
collector's old full-body assumption, a legacy fingerprint compatibility failure,
and an existing 30 ms AUTH timing fixture that expired before dispatch under
parallel load. Its test window was made robust without changing runtime policy.
Python's local certificate-store failure was worked around with verified TLS via
curl; certificate verification was not disabled. Independent review identified
native empty-body, hosted-alias and legacy-hash cases; each was corrected and
retested before the final passing source suite. Prior builds and failures remain.

The first release's notes PATCH omitted `tag_name`; its response retained a
temporary tag, which the initial prepublication guard failed to check. Publication
made that tag immutable. Formal-tag verification returned `release not found`,
and changing the immutable tag was rejected with HTTP422. That release and all
six assets are preserved and visibly marked superseded. The canonical release was
created with all explicit tag/source/notes fields. An early read during its upload
saw only five assets and failed the guard; after that same upload completed, all
six passed before publication. Canonical release/source/asset attestations and
anonymous downloads subsequently passed. No prior version was replaced.
