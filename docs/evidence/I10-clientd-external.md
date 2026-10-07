# I10 — external clientd installation and OpenClaw compatibility

Recorded on 2026-10-07 JST. The [local aggregate](I10-clientd-external-results.json)
is separate from public-provider/devnet evidence. It introduces an installation
and application-integration path that does not depend on the browser demo.

## Implementation

`clientd setup` accepts an independently pinned release plus an independently
reviewed deployment configuration. It creates a fresh private profile, distinct
random inference/management tokens and a journal directory, while preserving
manifest/build/artifact trust policy. It refuses existing profiles and relative
artifact/tariff paths. Setup is offline and does not initialize financial
custody, send AUTH or submit transactions. `run` uses the existing native SDK
runtime; `request` supplies local auth without shell secrets or retries.

The installation builder now supports a fresh `--output` directory, packs the
compiled SDK and installs it as an external tarball. It starts from the source
lock, rejects transitive dependency drift, then runs `npm ci` with lifecycle
scripts and command symlinks disabled. The installation contains Node, native
binaries, all runtime dependencies, the SDK archive, locked dependency graph,
secret-pipe helper and upstream license. It has no dependency on workspace
TypeScript source or the demo. Whole-install startup verification is retained.
No production signing/notarization or other-platform build is claimed.

The optional network `extra_ca` requires an independently pinned bounded PEM
file. It extends system roots while retaining TLS hostname checks, TLS version,
route restrictions and no redirect/proxy fallback. Native runtime also accepts
the SDK's explicit transaction `preparation_commitment`; actual financial
acceptance remains finalized. The default remains finalized preparation.

`openclaw-config` generates a numeric-loopback Chat Completions provider with an
inference-token file SecretRef and a dedicated agent. Setup creates the agent's
provider retry setting `maxRetries: 0`; the configuration disables fallback
models and ignores project-level overrides. The model must be configured for
Chat, and context/output limits are explicit inputs. No token contents or
provider keys appear in the generated configuration.

The [native quickstart](../sdk/clientd-quickstart.md) and
[OpenClaw guide](../integrations/openclaw.md) cover reviewed deployment inputs,
private setup, funding, model selection, explicit settlement/recovery and
withdrawal. A configured operator and reviewed deployment are still required.

## Local verification

The recorded distribution is
`target/clientd-distribution-final/distribution`, built with pinned Node
24.19.0 and Go 1.25.0. Its SDK archive SHA-256 is
`fc37358ce00fa7bcb5c43367c8f09b3908c617f9235e8646ae78003a21040c91`.
The aggregate records the release digest, dependency locks and exact source
hashes. The [preceding native package results](I10-clientd-external-pre-sse-fix-results.json)
retain the earlier SDK archive and its 415,504-CU SBF run. The final package
includes the later SDK SSE-reader correction and was freshly retested; OpenClaw
uses its own SSE reader through the native raw-stream interface.

Commands include:

```sh
ZKAPI_NODE="$PWD/target/i08-toolchain/bin/node" \
ZKAPI_GO="$PWD/target/toolchains/go/bin/go" \
PATH="$PWD/target/i08-toolchain/bin:$PATH" \
  python3 scripts/build_clientd_distribution.py \
  --output target/clientd-distribution-final/distribution

target/toolchains/go/bin/go -C apps/clientd test -count=1 -race -json ./...
python3 scripts/test_clientd_secrets.py

target/i08-toolchain/bin/node node_modules/typescript/bin/tsc \
  --noEmit -p apps/clientd/tsconfig.json

ZKAPI_TEST_CLIENTD_DISTRIBUTION_RESULT="$PWD/target/clientd-distribution-final/distribution-result.json" \
  target/i08-toolchain/bin/node --test --test-reporter=tap packages/sdk/test/clientd-sbf.ts

target/i08-toolchain/bin/node scripts/run_openclaw_clientd_acceptance.ts \
  target/openclaw-acceptance target/clientd-distribution-final/distribution
```

Results:

- **43 Go tests/subtests** passed with the race detector and no skips, including
  private setup, no overwrite, independent digest rejection, token separation,
  redirect/no-retry behavior, generated configuration and private CA/hostname
  verification.
- **Five secret-pipe tests** passed using synthetic keys/passphrases. TypeScript
  checking, Python compilation and whitespace checks passed.
- **One installed native/SBF scenario** passed with **nine signed transactions**,
  maximum **418,510 CU / 1,232 bytes**. This uses the real Go supervisor, compiled
  SDK, native proof/verifier and actual local Vault SBF for deposit/withdrawal,
  including transaction-result loss and process restart. RPC/indexer/control
  envelopes are local fixtures; it is not a public devnet result.
- **Ten OpenClaw checks** passed using the actual **2026.9.8 (fc23bc8)** CLI,
  production Go HTTP frontend, compiled SDK and encrypted journal. It validates
  generated SecretRefs; exercises ordinary Chat JSON and actual OpenClaw SSE
  text; executes OpenClaw's real read tool and sends the result in a separate
  inference; observes one provider inference on HTTP 503; terminates an actual
  OpenClaw process during a stream; holds a new process through uncertain
  inference/SDK recovery; and completes a new turn after explicit recovery.
  Eight deliberate fixture inferences, zero uncertain inference replays were
  recorded. Control, provider and proof verification are synthetic for this
  suite. SDK service reconstruction is not a clientd process restart; the SBF
  scenario above tests that separately.

The first new native SBF attempt failed because the historical local I05
manifest pinned the old IDL while the fixture loaded the current compiler IDL.
The failure remains in `target/clientd-external-final/sbf-test.log`. The test now
re-pins only its cloned synthetic manifest to the actual IDL bytes before
computing its explicit test manifest digest. It does not change the historical
I05 output, deployment pins or transaction formats. The corrected test uses
legacy `v0_buffer` and remains distinct from compact-deposit acceptance.

## Boundaries

These local suites do not fund public accounts, use provider credentials,
change the parent provider budget, establish public OpenClaw billing or assert
release gates. A later [separate actual devnet run](I10-openclaw-devnet.md)
completed OpenClaw text and a read-tool roundtrip, signed settlement, clean
settled restart and withdrawal with an independently collected finalized cut.
That live run used the installed runtime and production Go handler with a
bounded operator devnet Unix egress adapter, not the complete installed Go
supervisor. Its immutable earlier package is recorded separately from the final
portable package above. An OpenClaw tool roundtrip used 60-second reuse while
asynchronous provider settlement completed; the zero-reuse fixture alone did
not establish live tool continuation timing.

The independently configured browser host and old funded/private journals are
preserved. No user OpenClaw installation, configuration or chat was modified.
