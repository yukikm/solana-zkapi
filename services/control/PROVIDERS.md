# I06/I07 provider adapters

`controld serve` now connects direct issuance and the native inference routes to
one `Ledger` and the existing isolated signer. `RuntimeConfig.providers` defaults
to empty, so old I05 fixture configurations remain valid. Enabling the synthetic
`i05-local-only` adapter does not enable any provider HTTP adapter.

The current Vault keys/setup, listener, PostgreSQL transport and process layout
remain a **local acceptance profile**, guarded by `local_test_only` and loopback.
Live provider permissions/usage, external egress fencing, production secret
management, public RPC/wallet and release gates remain separate acceptance work.
The provider adapter implementation is exercised with HTTP fixtures, not a claim
that those fixtures are provider attestations.

## Configuration

Add `providers` to the private control configuration:

```json
{
  "providers": {
    "direct": [
      {
        "provider": "openrouter",
        "api_base": "https://openrouter.ai/api/v1",
        "inference_base": "https://openrouter.ai/api/v1",
        "credential_file": "/run/secrets/openrouter-management-key",
        "settlement_grace_seconds": 60
      }
    ],
    "proxy": [
      {
        "provider": "openai",
        "credential_file": "/run/secrets/openai-inference-key",
        "local_test_base": null,
        "models": [
          {
            "provider": "openai",
            "model": "REPLACE_WITH_VERIFIED_RELEASE_MODEL",
            "endpoints": ["chat_completions", "responses"],
            "context_tokens": 1,
            "max_output_tokens": 1,
            "cache_mode": "inclusive_read"
          }
        ]
      }
    ]
  }
}
```

The model and token limits above are placeholders, not a production profile.
Replace them with a verified provider/model/API-version fixture and published
limits, and pin the matching tariff hash in the trusted manifest. Each model
requires a tariff; old tariffs remain available for accepted sessions. Proxy
profiles require all applicable input, output and cache rates. The conservative
reservation uses the published context limit and the maximum applicable input
rate; an operation exceeding the note cap is rejected before provider egress.
Direct tariffs use `provider_reported_usd`, model `*`, and no token rates.

Secret files must be owner-only and contain the raw credential without a newline.
Use separate OpenRouter management and inference credentials. The service builds
provider request headers itself; client keys, cookies and forwarded headers are
never sent upstream. Proxy production targets are fixed, DNS-pinned to public
addresses, with redirects, environment proxies and automatic retry disabled.
Only explicit numeric loopback HTTP fixture origins may override proxy targets.

OA configuration uses `provider: "oa"`, `issuer_base`, `verifier_base`,
`inference_base`, `station_id`, and `credential_file`. The issuer/verifier pins
are exposed through `/zkapi/v1/attestation`; the issued key must verify at the
pinned verifier before initial delivery. OA lease durations are whole minutes
(60, 120, 180, 240 or 300 seconds). Receipt identity/amount/signature encoding
checks preserve the pinned upstream contract; they do not establish a new
independent cryptographic receipt verifier. See the I06 evidence for this limit.

## Inference and recovery

`GET /v1/models` and `/zkapi/v1/catalog` publish configured current profiles.
Proxy routes are OpenAI/OpenRouter Chat Completions, OpenAI Responses,
Anthropic Messages and optional Anthropic count_tokens. Responses always sends
`store=false`. Text and client function/tool calls are supported; unsupported
modalities, hosted tools, response history/background execution and unknown
metering parameters are rejected before egress. Anthropic version is pinned to
`2023-06-01`.

Every inference request needs `Idempotency-Key: UUIDv4` and its session's
`Bearer zkp1.<request UUID>.<base64url secret>` token. Anthropic routes also accept
that token in `x-api-key`, but never together with Authorization. Set Host to the
manifest inference origin. A supplied Origin must match the control or inference
origin. Requests are limited to 1 MiB, with session/IP throttling and a durable
16-call count_tokens limit per session. count_tokens is operator-funded.

The request body is retained only by the detached in-memory dispatch task. The
ledger stores its domain-separated secret-keyed HMAC, endpoint, model, attempt,
reservation, normalized usage and signed receipt. Same-operation retries return
409 metadata/status URLs; no inference body is replayed and no second upstream
request is issued. A slow/disconnected consumer cannot stop upstream metering.
The 600-second deadline is bounded independently from the admission TTL.

Direct keys appear only in the initial `SessionCreated.provider_key`. GET and
repeated POST cannot recover plaintext. They can close the saved management
reference. Issuance uncertainty never creates a replacement key. OpenRouter is
disabled, then exact USD is observed twice over the configured drain intervals,
then final usage is checkpointed before deletion. This operational stabilization
still requires live provider finality validation; it is not a mathematical
finality guarantee. A missing key before final usage stays pending. OA final
receipts follow its issuer's retirement lifecycle.

Proxy unknown usage is waived only during drain after the owner returned or was
independently fenced. Old-epoch unquiesced attempts stop admission and settlement;
restart/timeout alone is never fencing. I09 must provide deployment-specific
process/egress fencing. The local runtime suspends a provider after three unknown
observations in that process; this is an in-memory admission circuit breaker,
not a production monitoring service. Late provider evidence can be appended via
the existing ledger loss-receipt contract without changing settled charges.

Run `bash scripts/run_i06_i07.sh` for disposable PostgreSQL, provider HTTP fixtures,
real request proofs, signer process and actual Vault SBF regression. Reports are
written under `target/i06-i07/`. This script makes no live provider inference calls.
