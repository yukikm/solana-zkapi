# Public bundle downloads and matching proof validation

Recorded 2026-10-08 JST. **Passed:** 27 anonymous public downloads followed by six
new proofs generated from their exact downloaded bundle bytes. This closes the
download/proof-material check for this specific published profile; it does not
establish public operator readiness or funded client acceptance.

The published [consumer profile](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile.json)
has SHA-256 `5e868f8e57ef06961b73ba8cb755635e81d4bb168dd6ad498152496ac1b02d14`.
Its [complete schema-2 bundle](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/assets/bundle.json)
has SHA-256 `10a85725034a18bfa3e07913af9cdf89bd10ca05c4ce50aefe5f766a2431c9c8`;
the authenticated manifest hash is
`b97e200769be24448a51999346a28d0ca497892d68212f517b2b9bb4cc1a4643`.
All 27 files returned HTTP 200, matched their expected hashes, exposed public
credential-free CORS `*`, and advertised immutable caching. The initial Python
trust-store failure is preserved. The successful pinned-Node download retained
normal TLS certificate validation, used no credentials and followed no redirects.

The existing proof verifier loaded those downloaded files through an independently
installed SDK `0.2.0-devnet.2`, authenticated every descriptor file including
notices, and generated tree-insert, request and escape-withdrawal proofs through
both native and WASM engines. All six passed independent supplied-VK verification.
Each also rejected a zeroed proof, a changed public input and a mismatched VK
digest, for 18 negative checks. The bundle and installed SDK trees remained
unchanged. The measured proof-generation intervals totaled 42.741 seconds; this
is neither overall process duration nor a hosting performance guarantee.

WASM ran in Node, not a browser. Witnesses were unfunded and the quote was
synthetic/unsigned. The verification made zero RPC, provider, AUTH, funding or
transaction calls. Mutual-close, browser/Phantom, public financial lifecycles and
operator readiness remain separate observations. Prior local bundle results and
immutable releases remain historical.

The [machine-readable record](PD-public-bundle-download-proofs.json) contains
the complete HTTP observations, proof rows, notice hashes and source/report
digests. Original private-workspace output is retained under
`target/public-devnet-live-20261008/anonymous-bundle-proofs/`; public evidence
does not include a funded journal, signing seed, provider key or wallet secret.
