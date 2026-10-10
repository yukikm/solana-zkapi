# Configure the public Devnet gateway

First complete [operator setup](proxy-operator.md). The supplied gateway serves
control, tree and RPC routes for **direct OpenRouter Chat**. It does not relay
provider inference or translate other API dialects.

## Configure

Install an authenticated public profile, complete artifact bundle and private
configuration. Run from the repository root with the pinned Node version:

```sh
node scripts/public_devnet_gateway.ts --config /absolute/private/gateway.json
```

The listener binds only to `127.0.0.1`. The strict configuration accepts:

| Field | Value |
|---|---|
| `port`, `publicOrigin` | Loopback port and canonical public HTTPS origin |
| `allowedBrowserOrigins` | Exact HTTPS origins, or `["*"]` for public access without cookies |
| `allowNativeRequests` | `true` to allow native clients without browser Origin |
| `allowTransactions` | Global transaction-write switch |
| `allowNewAdmissions` | Separate new-session and new-deposit switch |
| `requireInvitation` | Defaults to `true`; explicitly set `false` for public admission |
| `admissionTokenSha256` | Required for invitation-gated new admission |
| `profileUrl`, `profilePath`, `profileSha256` | Canonical profile URL, installed file and independently authenticated digest |
| `bundleDescriptorPath` | Installed descriptor, with referenced public assets beside it |
| `rpcUrl`, optional `historyRpcUrl` | Private HTTPS RPC upstreams |
| `indexerUrl`, `controlUrl` | Fixed HTTPS or numeric-loopback HTTP service origins |
| optional `localCaPath` | Local service CA file; certificate checks remain enabled |
| `budget` | `{"kind":"operator-funded"}` for operator-paid usage without a trial count |
| optional `modelProfile` | `{url,path,sha256}` for a pinned model catalog using the same deployment, bundle, tariff and cap |

Use the exact [configuration contract](../../scripts/public_devnet_gateway.ts).
The profile RPC must be `publicOrigin + "/rpc"`; control and indexer identities
must match the authenticated deployment. The supported public profile has a
1,000,000-micro-USDC session cap and OpenRouter base `https://openrouter.ai/api/v1`.
Arbitrary endpoints, profiles and caps are rejected.

For invitations, generate 32 random bytes as unpadded base64url (43 characters).
Pin SHA-256 of the UTF-8 token text. Distribute the token privately; never put it
in a public profile, URL or log. Clients send `x-zkapi-admission` only for session
AUTH. The gateway strips it before forwarding.

Existing finite budget configurations retain their original authorities and
reservations. Do not initialize a replacement budget to restore access.
Operator-funded mode keeps control-ledger reservations, caps and signed settlement;
the operator remains responsible for provider credit and charges.

## Publish HTTPS

Use the [same-origin nginx template](../../deploy/public-devnet/nginx.same-origin.conf.example)
or [CloudFront template](../../deploy/public-devnet/nginx.cloudfront.conf.example).
Replace hostnames, certificates and paths with your deployment values. Validate
nginx and the [systemd units](../../deploy/public-devnet/systemd/README.md) on the target host.
Keep upstream retries disabled and private service ports unexposed.

Publish the profile and complete bundle on immutable HTTPS storage with the
required CORS policy. The gateway does not serve application or private files.
Browser requests use `credentials: "omit"`; wildcard CORS cannot use cookies.
Do not change the origin or custody namespace of an existing funded application.

## Verify

- `/relay-status`: configured policy only; it does not probe dependencies.
- `/provider-budget`: budget/admission policy; provider credit is not checked.
- `/zkapi/v1/readiness`: bounded control, indexer and signer checks; it does not establish provider credit or challenger readiness.
- [Consumer preflight](devnet.md): authenticated assets, manifest, chain, tree and model checks.
- [Private monitoring](operations.md): ledger, signer, challenger, fee payer and storage.

For maintenance, set `allowNewAdmissions: false` and retain
`allowTransactions: true` so existing settlement and withdrawal can continue.
Global `allowTransactions: false` also stops recovery writes. Admission suspension
does not revoke already issued provider keys; finish their existing lifecycle.
