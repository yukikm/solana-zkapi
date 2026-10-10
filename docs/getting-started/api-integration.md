# API integration and the payment lifecycle

ZKAPI separates paying for API access from the API's request and response
format. A client funds a USDC note, proves that it can authorize capped usage,
uses a provider and verifies the signed settlement before spending again or
withdrawing. Local custody, proofs and settlement are the reusable foundation.

This guide is the starting point for application developers and API providers.
Inference is one use case, including OpenRouter and OpenAI integrations. It does
not define the scope of ZKAPI's payment protocol. The pinned
[Ethereum upstream](https://github.com/ethereum/zkapi) likewise describes access
to AI and other APIs; application adapters determine which requests can run.

The current source adds **registered POST JSON APIs with a fixed price per
successful request**, using the existing payment lifecycle. Start with
[the local JSON API tutorial](json-api.md). This is a source/local integration;
the published `.8` SDK and native package retain their inference interfaces.
See [Inference API getting started](inference.md) for those integrations.

## Identify the roles

| Role | Responsibility |
|---|---|
| Application / client | Keep encrypted custody, obtain user authorization, prove locally, call the API and verify settlement |
| API provider | Execute requests and expose the usage evidence required for billing |
| ZKAPI operator | Publish deployment and tariff information, authorize capped sessions, account for usage and sign settlement |
| Solana Vault | Hold USDC and verify the on-chain proof and state transitions for funding and withdrawal |

A provider can also operate ZKAPI. Applications use `WalletClient`,
`ControlClient` and the shared encrypted journal through the SDK; clientd is
the supplied local bridge. Operators use the existing
control service, accounting ledger and independent signer journal.

## Follow one payment lifecycle

1. **Verify the deployment.** Obtain its authenticated manifest, profile, circuit
   artifacts and tariff. Check the chain, Pool and service identities before
   funding. The [deployment reference](../sdk/deployment.md) describes these bindings.
2. **Fund a note.** Deposit through `WalletClient` or the SDK's wallet methods
   and wait for finalized confirmation. A direct token transfer to the Vault
   does not create a note. Keep its custody, journal and recovery material.
3. **Authorize capped usage.** Verify a signed quote, save the request ID and
   credentials, and generate a local proof. The control service reserves the
   authorization before enabling provider access.
4. **Call the API.** Proxy adapters validate requests and reserve a conservative
   cost before dispatch. Direct integrations use restricted provider credentials
   and the provider's accounting policy. Retain operation identity when checking
   an uncertain result.
5. **Settle and verify.** Close or expire the session, reconcile usage and verify
   its signed charge and successor state before advancing the local journal.
   A successful API response alone does not mean settlement has finished.
6. **Continue or withdraw.** Reuse the verified state for the next authorization,
   or withdraw through the existing wallet lifecycle. Resolve pending work
   before starting another authorization for the same note.

Amounts use integer micro-USDC; proxy accounting accumulates finer integer
nano-USDC units and rounds the session total under the
[accounting contract](../specs/api-proxy.md#cost-bounds). SOL pays network fees.
See [recovery](../sdk/recovery.md) for lost responses and interrupted operations.

## Choose how requests reach the provider

| Mode | Request path | Integration requirement |
|---|---|---|
| Direct | Client → provider | Provider-specific restricted access, verifiable issuance, retirement and usage capture |
| Proxy | Client → operator → provider | Validated request schema, a conservative cost reservation and trustworthy usage accounting |

Direct mode requires a provider that supports the credential lifecycle; an
ordinary long-lived API key is not sufficient. Proxy mode supports centralized
credential handling, but the operator receives request and response content.
Do not silently switch a direct integration to proxy.

Direct settlement follows the provider's usage-capture policy and caps the
customer's charge. For the implemented OpenRouter adapter, delayed or unobserved
provider costs remain the operator's responsibility; they cannot increase an
already signed settlement.

ZK proofs establish balance and authorization conditions. They do not prove
that an API result is correct, that provider usage is truthfully reported or
that a provider deleted request data. See the [architecture](../architecture.md)
for these trust boundaries.

## Integrate another kind of API

A data lookup can now use a registered `POST` operation that accepts JSON and
returns bounded JSON. Its signed descriptor identifies the service, operation,
upstream origin/path, method, size limits, deadline and billing rule. A version 2
tariff prices `requests`; neither the body nor the tariff needs a model or token
count. The proxy charges one unit only after an HTTP 2xx response with valid
JSON. An observed HTTP failure costs zero; an uncertain execution is never
replayed and follows the existing operator-loss settlement rules.

Register the operation and an authenticated tariff as shown in the
[JSON API tutorial](json-api.md). Extending beyond this first adapter still
requires an explicit contract. Define:

| Contract | What the integration must specify |
|---|---|
| Requests | Allowed methods, paths, headers, body fields, size limits and response handling |
| Price and cap | Billable units and exact arithmetic; proxy cost reservations or direct credential limits and capped usage accounting |
| Usage evidence | How completed, failed and interrupted executions are accounted for, and what can be independently verified |
| Access and retirement | Credential scope, expiry, revocation, usage-capture policy and responsibility for delayed or unobserved costs |
| Recovery | How to inspect an uncertain execution without dispatching it again, and how unresolved usage affects settlement |

Then extend the existing implementation in these places:

1. **Contracts and profiles.** Update the [API and accounting specification](../specs/api-proxy.md),
   [OpenAPI contract](../contracts/openapi.json) and corresponding implementation
   types when adding new methods, response formats or billing units. Generic
   quotes bind `api`; inference quotes retain their original provider/model
   fields. Do not relabel calls as tokens. Document versioning and compatibility.
2. **Provider adapter.** Implement validation, cost bounds, dispatch and usage
   reconciliation in the [control service](../../services/control/README.md).
   Reuse its dispatcher, durable reservations, ledger and sign-once settlement.
   A new provider URL alone cannot supply those guarantees.
3. **Client transport.** Extend the [SDK interfaces](../sdk/api.md) and request
   validation while retaining `ControlClient`, `WalletClient`, `ClientDaemon`
   and the existing encrypted journal. `requestApi()` selects a registered
   JSON operation; `request()` retains `chat`, `responses` and `messages`.
4. **Verification and publication.** Add reproducible request, metering,
   interrupted-execution, settlement and recovery tests. Check the complete
   funding-to-withdrawal lifecycle before advertising support. Publish the
   adapter capabilities, tariffs and authenticated deployment profile together.
   Keep synthetic fixtures distinct from live acceptance evidence.

Never replay an uncertain API request or advance the same note twice. Preserve
existing funded profiles and journals when extending the SDK. Any required
protocol, circuit or trust change needs explicit documentation; adding an API
does not itself authorize replacing custody or a deployed Pool.

Arbitrary URL forwarding, arbitrary methods/headers, streaming, async jobs and
provider-independent direct credentials are outside this initial JSON adapter.
Side-effecting APIs need upstream execution lookup or idempotency support to
resolve uncertain results safely. Registration alone cannot supply that support.

Use [Contributing](../../CONTRIBUTING.md) and [Testing](../testing.md) for local
development, and [operator setup](proxy-operator.md) for the service components.
The [support page](../support.md) lists the currently implemented and observed
scope separately from these integration requirements.
