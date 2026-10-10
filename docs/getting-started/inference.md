# Inference API getting started

This is the inference-specific path through ZKAPI. For the general API payment
lifecycle and other API integrations, start with [API integration](api-integration.md).

The supplied clients and adapters implement selected Chat Completions, Responses
and Messages APIs. The public Devnet profile uses **direct OpenRouter Chat
Completions**. A model name does not enable a different request format; check
the deployment's advertised capabilities and [current support](../support.md).

## Connect an existing inference client

1. [Install and run clientd on macOS](clientd.md). The published native archive
   supports Apple Silicon and macOS 13.5+. The commands and installation folders
   in that guide are specific to that platform.
2. Follow [Devnet setup](devnet.md) for connection checks and test funds.
3. [Connect OpenClaw on macOS](openclaw.md), or point a compatible client at
   clientd's local Chat Completions endpoint using its private inference token.

OpenClaw is a client. OpenRouter is the provider in the public profile. OpenAI
is a separate provider; protocol names or configuration values such as
`openai-completions` describe an API format and do not select OpenAI as the
upstream provider.

These guides document configuration and known compatibility limits, rather
than supported end-to-end client flows:

- [Claude Desktop](claude-desktop.md)
- [Claude Code](claude-code.md)
- [Codex](codex.md)

## Build an inference application

Use the [inference SDK tutorial](sdk.md) for browser custody, local proofs,
funding, a Chat Completions request, settlement and withdrawal. It uses the
public OpenRouter profile as a concrete example. It does not require clientd
or a macOS installation. Funded browser/wallet acceptance remains unverified;
see [support](../support.md).

The [SDK reference](../sdk/README.md) describes the exact request APIs and
recovery methods. The [reference chat app](https://github.com/yukikm/solana-zkapi-client)
is maintained separately.

## Connect an inference provider

Follow [inference provider setup](api-provider.md) to select an implemented
direct or proxy adapter, provision provider credentials, configure model
capabilities and publish matching tariffs. Operators also need the shared
[authorization and settlement services](proxy-operator.md).

Devnet USDC is a test asset; provider credit is separate. Public preflight and
model listings do not guarantee inference credit, success or availability.
