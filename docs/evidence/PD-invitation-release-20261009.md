# Invitation-free API release publication — 2026-10-09

The immutable [v0.2.0-devnet.4 Devnet prerelease](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.4)
was published at **02:51:36 UTC** (11:51:36 JST), release ID **407445861**.
[Source commit `0341002`](https://github.com/yukikm/solana-zkapi/commit/03410028e939c1489af129880ae05b3e7dce3604)
was pushed to `main`; the release tag resolves to that exact commit. GitHub
release-signature verification passed. All **four assets** were independently
downloaded anonymously with normal TLS verification and matched their prepared
SHA-256 hashes and lengths. The [JSON record](PD-invitation-release-20261009.json)
contains the artifact joins, full source identity and hosted-CI snapshot.

The attached source archive contains **1,696 tracked files**, each independently
compared with its committed Git blob. The pinned vendor submodule is not embedded;
a recursive Git checkout is required for complete builds. Other attachments are
the release manifest, the local gateway test report and `SHA256SUMS`.

The isolated publication checkout passed **48 gateway/relay tests**, zero skips,
on Node 24.19.0 and npm 11.9.0. Its two runtime source hashes match the installed
[gateway update](PD-invitation-removal-20261009.md). Existing full-cap budget,
normal authentication, proof validation and exact recovery remain enforced.
Only the explicit invitation gate is disabled on the public gateway.

**SDK and native client remain `0.2.0-devnet.3`.** Runtime and package inputs have
not changed since that release; the only SDK source-tree difference is a
previously published E2E test fixture. Every one of the **65 packaged SDK files**
matched the original downloaded `.3` artifact. The diagnostic rebuild's archive
hash differs because 60 generated files have mode 0644 instead of the original
0600; file contents are identical. No replacement SDK archive, SDK version bump,
native rebuild or npm publication is needed. Release notes link the original
immutable `.3` SDK/native downloads and retain all profile and custody bindings.

[Hosted implementation CI](https://github.com/yukikm/solana-zkapi/actions/runs/37876369838)
was **in progress** in the recorded cut: contracts, Node and Go succeeded;
six other jobs were running. This is not an all-nine-job pass. The latest
separately captured public readiness response still returned **HTTP 503 with
indexer unavailable**. Publication does not establish restored availability,
provider credit, new live acceptance or mainnet readiness.

No inference, AUTH, wallet transaction, budget initialization or chat application
edit was performed for publication. Earlier releases, failure observations,
original journals and deployment evidence remain preserved.
