# OpenClaw settlement scheduling adapter: local verification

The [explicit scheduling adapter](../integrations/openclaw-settlement-adapter.md)
passed **10 local fixture tests, zero skips, in 1.498 seconds** using the installed
native preview's pinned Node executable. All three guarded inputs remained
unchanged during the successful run. No OpenClaw invocation, AUTH, inference,
funding, journal mutation, or live service change occurred in these tests.

The [N-01 native result](PD-native-public-N01.md) exposed a practical boundary:
the native response can finish before direct-provider usage reconciliation does.
The configured 120-second wait on the next native request does not cover every
settlement. The adapter holds the second input outside native admission until
authenticated SDK status verifies a new ready journal head for the observed
first operation. It preserves the released runtime, profile, original gate,
request bytes and UUID; it never retries an inference. This is additional
consumer-adapter behavior, not stock immediate-continuation compatibility.

The fixtures cover exact second-input preservation and one forward, distinct
management/inference credentials, monotonic journal heads, mismatched pending
operations, hard status errors, cancellation before forwarding, and immediate
continuation or reader cancellation at SSE `[DONE]`. The first terminal SSE event
is withheld until native EOF and pending-identity validation finish; preceding
events stream without rewriting their bytes.

Two failed fixture checkpoints are retained. The first passed 5 of 10: strict
JSON parsing creates null-prototype objects, and an ordinary-object equality
assertion incorrectly rejected valid pending status. Exact key/value checks and
a strict-parsed positive fixture corrected it. The second passed 9 of 10: a
cancellation fixture released its delayed status response before the server
observed TCP cancellation. The corrected fixture waits for that observation;
runtime cancellation behavior was unchanged. Neither failure involved a live
service or financial request.

The separately prepared private configuration adds a management-token file and
a new, unused adapter-state path. All 37 historical preparation-file hashes
still match. Neither the adapter nor OpenClaw has been launched by this
preparation. Funded N-02/N-03 acceptance, final settlement, and broader agent
compatibility remain separate evidence. Exact source and test-result hashes are
in the [machine-readable checkpoint](PD-openclaw-settlement-adapter.json).
