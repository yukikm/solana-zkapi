# Public Devnet asset publication

Recorded 2026-10-08 JST. The user approved the roughly USD50/month AWS US East
preview and its generated HTTPS hostname. The immutable public asset prefix is
[`public-devnet-20261008-a`](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/assets/bundle.json).
Earlier `.1` releases and private deployments remain unchanged.

The exact 26-file distribution review passed before conditional, create-only
uploads. The complete bundle retains ten notice/provenance files, including the
reviewed original author's Apache-2.0 grant for the four inherited setup files.
The new tree setup is OS-random single-party Devnet setup, not a multiparty
ceremony. The profile was uploaded separately, for 27 public files in total.

| Public identity | SHA-256 |
|---|---|
| [Profile](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile.json) | `5e868f8e57ef06961b73ba8cb755635e81d4bb168dd6ad498152496ac1b02d14` |
| Bundle descriptor | `10a85725034a18bfa3e07913af9cdf89bd10ca05c4ce50aefe5f766a2431c9c8` |
| Canonical manifest | `b97e200769be24448a51999346a28d0ca497892d68212f517b2b9bb4cc1a4643` |
| WASM | `c06a247e1ff88f1ac415ea127bcf49d486b5b4954715cdf00f133b5ac71c1f30` |
| Exact per-file distribution review | `67d9ef38643a84fbbdaf160113f8ec9aff90979261ceb2c61964fc42bdf28060` |

[Anonymous download observations](PD-public-assets-download.json) verify all
27 files, 26,769,587 bytes, exact hashes, immutable cache headers and CORS.
The requests omitted credentials, rejected redirects and retained TLS
certificate validation. The initial Python 3.13 attempt failed because its
local certificate store could not validate the issuer. No files were accepted
from that attempt; pinned Node 24.19.0 completed the subsequent strict-TLS run.

[Independent installed-package proof results](PD-public-assets-proofs.json)
use those downloaded bytes: six newly generated native/WASM tree, request and
withdrawal proofs, six independent supplied-verification-key checks and 18
negative checks passed. All guarded inputs remained unchanged. WASM executed
under Node in this scope. These were offline unfunded genesis witnesses and
synthetic unsigned quotes, with zero RPC, AUTH, provider or transaction actions.

This records actual publication and proof compatibility. It does not establish
browser execution, deployed service readiness, Pool initialization, provider
acceptance or a complete public consumer lifecycle. Those require separately
recorded live results. The profile digest above is an independently reviewed
trust anchor only when this document itself is obtained through a trusted
channel; fetching a digest solely from the asset server is insufficient.
