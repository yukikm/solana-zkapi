# Getting started

ZKAPI supplies payment, authorization and settlement primitives for API usage.
Start with the general integration guide, then choose the implementation that
fits your service. This project is a **Devnet preview**; check
[support](../support.md) for current capabilities.

## Integrate an API

- [API integration and the payment lifecycle](api-integration.md) — client,
  provider and operator roles; funding, authorization, usage and settlement.
- [Fixed-price JSON API](json-api.md) — run the local deposit, request,
  settlement and withdrawal lifecycle using the source SDK.
- [Integrate another kind of API](api-integration.md#integrate-another-kind-of-api)
  — define request validation, pricing, usage evidence and recovery, and extend
  the existing SDK and service contracts.
- [Architecture](../architecture.md) and [SDK reference](../sdk/README.md) —
  components, shared custody and exact interfaces.

The source SDK supports registered JSON operations and inference adapters.
The published `.8` clients retain their documented inference scope. Additional
API formats and billing rules require explicit integration.

## Use an inference API

Follow **[Inference API getting started](inference.md)** for the runnable
inference examples:

- [clientd on macOS](clientd.md) and [OpenClaw on macOS](openclaw.md).
- [Inference SDK tutorial](sdk.md) for your own application.
- [Inference provider setup](api-provider.md) for operators.

The inference index also links compatibility notes for Claude Desktop, Claude
Code and Codex. Their current request formats have limitations for normal use.

## Operate a service

1. [Create a new Devnet deployment](deployment.md), or prepare your existing verified deployment inputs.
2. [Set up the operator services](proxy-operator.md) with the adapter and tariff
   for your integration; the supplied [provider setup](api-provider.md) covers inference.
3. For the supplied public gateway, use the [gateway configuration](gateway.md).
4. Set up [monitoring and recovery](operations.md), [backup and restart](backup-and-restart.md),
   and [archive storage](archive-storage.md).

Operator setup requires a matching Solana program, Pool, keys and deployment
artifacts. This repository does not provide a production-ready one-command installer.

[Devnet funds and connection details](devnet.md) covers test SOL, test USDC and
deployment verification. Platform-specific installation guides state their OS
requirements.
