# Public API CORS source release — 2026-10-09

The immutable [v0.2.0-devnet.5 Devnet prerelease](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.5)
was published at **04:27:07 UTC / 13:27:07 JST**, release ID **407508349**.
[Source `e1da525`](https://github.com/yukikm/solana-zkapi/commit/e1da525580d5aa9732c80a23fc203b063967afbb)
was pushed to `main`; the release tag resolves to the same exact commit.
[Machine-readable evidence](PD-cors-release-20261009.json) records the asset,
source, signature and CI checks.

The release adds the requested public CORS configuration `allowedBrowserOrigins:
["*"]` and its tests and documentation. The two runtime sources match the
[already installed gateway change](PD-public-cors-20261009.md), receipt
`23b935c6…bbf12`. Publication performs no additional service restart or change
to the gateway, financial database, reservations, custody or independent chat app.

The isolated release checkout passed **51 gateway/relay tests**, zero skips,
with pinned Node **24.19.0** and npm **11.9.0**. All **1,702 archived source files**
were verified against their committed Git blob identities. The source archive
excludes the pinned vendor submodule; a recursive Git checkout is required for
complete builds. The other assets are the test report, release manifest and
`SHA256SUMS`.

GitHub release and all four asset attestation checks passed. All **four assets**
were independently downloaded anonymously with normal TLS verification and
matched their prepared lengths and SHA256 digests. Release immutability is
confirmed. Earlier immutable releases remain unchanged.

**SDK and native clients remain `0.2.0-devnet.3`.** Their runtime, dependency and
packaging inputs match the existing published `.3` release; no client rebuild,
version bump, archive replacement or npm publication is needed. Existing clients
already omit browser credentials and can use the changed public CORS policy.
The original profile and custody bindings remain unchanged.

[Hosted implementation CI 37883726099](https://github.com/yukikm/solana-zkapi/actions/runs/37883726099)
was still in progress at the recorded cut: **Node, Go and contracts succeeded;
six other jobs were running**. No all-nine-job pass is claimed. The earlier
browser CORS verification observed separate tree-root HTTP503 responses,
including the 04:16:05 UTC follow-up. Their cause remains unresolved. This
publication establishes neither a repair of that upstream failure nor continuous
API availability, provider credit, funded browser acceptance or mainnet readiness.

The primary workspace retains its pre-existing unrelated changes. Publication
used a separate checkout from `2524e416…57ef7e`; only the nine reviewed CORS
source/test/documentation paths entered the implementation commit. This
publication evidence is a later documentation update and does not rewrite the
immutable source tag.
