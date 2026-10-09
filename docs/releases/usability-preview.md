# Privacy and recovery usability — SDK/native 0.2.0-devnet.8

This client release adds read-only upgrade guidance, an explicit ZDR catalog
check and structured privacy information. It retains `.7` request filtering,
mandatory direct OpenRouter ZDR/data-collection-deny and journal minimization.

## Existing installations

Keep the original runtime, profile, journal, keys and recovery inputs. A new
profile must not replace an existing custody binding. This release provides
guidance, not an in-place custody migration or an automatic financial action.

Obtain a fresh status from the original running native installation:

```sh
/absolute/original/bin/clientd request /absolute/original-profile status > original-status.json
```

The new distribution's offline helper reads that status without opening the old
journal, connecting a wallet, starting a daemon or contacting the network:

```sh
/absolute/new/bin/node /absolute/new/tools/public-devnet-consumer/cli.mjs \
  upgrade-plan --status-file original-status.json
```

SDK hosts can call `planClientUpgrade(await originalClient.status())` using the
new package's `@zkapi/solana-sdk/client-guidance` export. A current `.8` client
also has `await client.upgradePlan()`. Native `.8` exposes
`clientd request /absolute/profile upgrade-plan`.

The plan lists pending responses, wallet work, sessions, emergency recovery and
unclosed notes. An active zero-balance note still needs its original closure.
An unresolved escape remains a blocker after withdrawal. Incomplete older
status is `unknown`; it never permits replacing custody. Complete the listed
recovery/closure using the original installation. No uncertain inference is
replayed. A ready result permits only a separate installation and new custody,
while retaining the original recovery material. Local status is not a fresh
chain attestation; refresh it immediately before following the plan.

## ZDR model availability and errors

`await client.checkModelAvailability()` or
`clientd request /absolute/profile model-availability` makes one explicit,
keyless `GET /models?zdr=true` through the installed provider base and transport.
It sends no prompt, wallet information or selected model IDs. Ordinary
status/model-list reads do not poll the provider.

The result intersects the public catalog with the pinned model allowlist:

| Status | Meaning |
|---|---|
| `zdr_endpoint_listed` | Listed in the public ZDR catalog at `checkedAt` |
| `not_listed` | Absent from that complete catalog snapshot |
| `unknown` | Timeout, network failure, malformed/incomplete catalog or missing base |
| `not_applicable` | Proxy/OA mode; no ZDR assertion |

Catalog presence does not establish account permissions, credit, data-collection
policy, capacity or inference success. The mandatory policy still applies to
every actual request. Metadata never changes the pinned catalog, tariff, mode or
privacy policy. See the [official models API](https://openrouter.ai/docs/api/api-reference/models/get-models).

Direct OpenRouter HTTP failures retain their HTTP status and get a bounded JSON
error plus `X-Zkapi-Error-Code`: `zdr_endpoint_unavailable`,
`model_endpoint_unavailable`, `provider_access_denied`,
`provider_budget_unavailable`, `provider_rate_limited`, `provider_unavailable`
or `provider_request_rejected`. A generic 404 is not called a ZDR error; the
provider must explicitly report a privacy-policy endpoint mismatch. Raw provider
messages, metadata and identifying headers are not echoed. Inspect status and
finish required recovery/settlement before a deliberate new request. There is
no automatic retry, mode/model switch or ZDR relaxation. Successful responses
and streams retain their existing format; errors embedded in an HTTP 200
provider stream are not reclassified by this HTTP error helper.

## Structured privacy information

SDK `status().privacy` and native `/admin/status`'s `privacy` contain a detached,
versioned object: content recipients, required routing policy, transport-dependent
IP visibility, deletion-verification limits, lease reuse and local retention.
The existing `privacyNotice` / `privacy_notice` remains for compatibility.
Reports contain no prompt, key, wallet address or provider error text.

ZDR routing is not proof of provider deletion. IP protection depends on the
installed transport; the report does not attest Tor or promise anonymity.
Requests within a reused direct lease can be linked. Legacy bodies, fingerprints,
external backups and application transcripts retain the `.7` documented limits.

## New-consumer profile and distribution

Use the [GitHub `.8` release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.8)
after verifying its attestations and checksums. Distribution uses GitHub assets,
not npm; native support is macOS ARM64, macOS 13.5+, without Apple signing/notarization.

```json
{
  "schema": 2,
  "chain": "solana:devnet",
  "label": "Public Devnet — SDK .8 privacy and recovery guidance",
  "profileUrl": "https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.8-r6.json",
  "profileSha256": "ec10c1ab41bb5105222d3e25c7e1eba6b96b1b397abd0f854657030269992a77"
}
```

Revision 6 changes only revision and SDK compatibility. Its 21 models, deployment,
proof artifacts, tariffs and policy remain unchanged. Gateway discovery and old
profiles retain their bindings. The helper's `model-availability` command accepts
the same profile flags as `preflight` and uses direct HTTPS; use the native
management command for metadata through an installed Tor policy.

```sh
npm install --save-exact /absolute/downloads/zkapi-solana-sdk-0.2.0-devnet.8.tgz @solana/kit@8.4.0
```

No program authority, proof setup, grant or financial state changes are part of
this release. The [remaining trust differences](privacy-preview.md#trust-comparison-with-ethereum)
remain. [Publication, signatures and downloads are verified](../evidence/PD-sdk8-publication-20261010.md).
The public operator's empty catalog currently blocks ordinary preflight on both
`.7` and `.8`; the metadata helper's successful read is a separate observation.
