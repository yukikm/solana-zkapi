# Privacy hardening preview — SDK and clientd 0.2.0-devnet.7

This release contains the SDK tarball, macOS ARM64 native archive, source archive,
an immutable revision-5 public profile, a release manifest and SHA-256 checksums.
Publication verification is recorded separately after upload.

## Changes

- Direct Chat and Responses use API-specific allowlists at daemon admission and
  the low-level SDK dispatch boundary. Unknown identity/transport fields are
  rejected before authorization. Text tools and structured-output schemas remain
  supported. OpenRouter model suffixes and presets that could enable hosted tools
  are rejected, including `:online` and `@preset` syntax.
- Direct OpenRouter always requests `provider: {zdr: true, data_collection: "deny"}`.
  Contradictory or additional provider preferences are rejected. A provider error
  does not trigger a retry, model/mode switch or weaker retention policy.
- Direct request bodies are never written to the journal. Proxy bodies are kept
  only while unsent; the atomic send transition replaces them with a redaction
  marker and SHA-256 of the exact dispatched bytes. Verified settlement also
  redacts unsent/legacy bodies in that session and its emergency copy. The hash
  retains exact-request evidence for the existing acceptance collectors.
- `client.purgeSettledRequestBodies()` and native
  `clientd request /absolute/profile purge-settled-bodies` explicitly erase bodies
  and fingerprints from settled history and settled emergency copies. AUTH,
  receipts, operation IDs/phases, balances, signatures and wallet transaction
  bytes remain. Calls are atomic, idempotent and do not send network requests.

A fingerprint can identify identical or guessable content to someone with journal
access. Erasure preserves active requests and unresolved escape archives, including
unchallenged closed-wallet archives; external backups, filesystem snapshots and
application transcripts remain separate. Reading a legacy record does not rewrite
it. See [retention and recovery](../sdk/recovery.md#local-request-retention).

The routing policy applies to direct OpenRouter. It is not a claim that the proxy
service or OA gained ZDR, nor cryptographic evidence of provider deletion.
[OpenRouter's ZDR definition](https://openrouter.ai/docs/guides/features/zdr)
permits implicit in-memory caching. Providers still see prompts and network
metadata. Qualifying endpoint availability can reduce model availability; no live
inference is needed or claimed by this release's read-only preflight.

## New-consumer profile

Revision 5 changes only the revision and SDK compatibility of revision 4. The
21-model catalog, deployment, proof artifacts, tariffs and preparation policy
remain identical. New `.7` consumers explicitly install this profile:

```json
{
  "schema": 2,
  "chain": "solana:devnet",
  "label": "Public Devnet — SDK .7 privacy hardening",
  "profileUrl": "https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.7-r5.json",
  "profileSha256": "8c11a03fe09a6fb8c4361d89bfea3fb7a2d831bb5b6f956634bcdd94ad49d703"
}
```

Gateway discovery and existing custody bindings are not changed by this release.
Keep the original SDK/runtime, profile, journal and recovery inputs for funded or
uncertain custody. The new profile is not an automatic custody migration. Old
immutable releases remain available. Distribution is through the
[GitHub prerelease](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.7),
not the npm registry. The native platform remains macOS ARM64, macOS 13.5 or later,
without Apple signing/notarization.

After verifying the release and asset checksums:

```sh
npm install --save-exact /absolute/downloads/zkapi-solana-sdk-0.2.0-devnet.7.tgz @solana/kit@8.4.0
/absolute/zkapi-clientd-0.2.0-devnet.7-darwin-arm64/bin/node \
  /absolute/zkapi-clientd-0.2.0-devnet.7-darwin-arm64/tools/public-devnet-consumer/cli.mjs preflight \
  --profile-url https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.7-r5.json \
  --profile-sha256 8c11a03fe09a6fb8c4361d89bfea3fb7a2d831bb5b6f956634bcdd94ad49d703
```

## Trust comparison with Ethereum

The pinned Ethereum request/withdrawal proving-key files remain byte-identical
(`045b444ea1b52538d1b40273c7cb6ed09468a052`, verified by `scripts/check_upstream.py`).
That establishes source/artifact identity, not identical program reliability.
Solana additionally verifies a tree-transition proof. The public deployment uses
an OS-random single-party tree setup marked `test_only`, with no verified ceremony
transcript. Ethereum's pinned Vault computes tree updates directly and uses native
ETH; this Solana deployment uses a USDC mint with issuer/freeze authorities.

A fresh finalized public RPC observation on 2026-10-09 at 18:15:31 UTC (slot
509266027) found program `2sXbYtY2NbyGm1GeCETkkjAa5LxWCA8v8aj2ePW3yVDH`
still upgradeable by `nHSjCbSd3XD3UwGy5uAAUqEfDf4kBDYaJZ4eF82nCDZ`, matching the
manifest's single-key declaration. The pinned Ethereum Vault has immutable proof
adapter/key parameters, though its owner can pause and change the treasury.
Thus the current trust assumptions differ even without considering mainnet or
third-party audit status. This client release changes no program, authority,
proof setup, financial state or provider grant capacity.
