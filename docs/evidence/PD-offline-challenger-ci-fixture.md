# Offline challenger launcher CI fixture repair

The repaired offline launcher test passed **16 named checks in 4.039 seconds**
using real native binaries and a new disposable PostgreSQL cluster. Production
runtime and public deployment pins are unchanged. This is local fixture evidence;
a successor full hosted-CI pass and funded public acceptance are not claimed.

Implementation CI at `0fe68818559f2c73accd8b200c169054dff67823` (run
`37722524764`) failed in the offline challenger stage because the final Python
command omitted PostgreSQL from PATH. Inspection also found references to
ignored Devnet deployment/program directories, a missing `provider_state`
argument, and a release-profile check whose binary was not built by prior I09
stages. The workflow now supplies the PostgreSQL binary directory and explicitly
builds the release challenger, preserving the existing release check.

The test creates a disposable configuration from the existing I04 ELF, I05
manifest, current compiler-backed IDL and I09 tree proving key. A deterministic
public test seed signs the fixture manifest through the existing SDK/Kit code;
SDK signature verification and actual native trust validation both remain
required. The initialization slot is synthetic and labeled as an offline fixture.
No user key, existing Devnet deployment directory or existing backend is used.

The first generator passed SDK checks but retained the local I04 program address
`[43;32]`, which native Devnet trust deliberately rejects. That failed native run
is retained separately (exit 1 before PostgreSQL startup). The corrected fixture
uses `[71;32]`, matching the existing native `devnet_config.rs` test pattern, and
rebinds only the compiler IDL's address and corresponding manifest/build/binding
fields. The compiled I04 ELF stays byte-identical and is used solely for offline
hash binding. This is not a deployed-program or SBF-execution claim. The initial
generator, SDK-only success, native diagnostic and failed test log are preserved.

The final run covers native initialization and same-journal reopen, actual
release-binary selection, SELECT-only database authority (including explicit
READ WRITE rejection), missing/substituted cluster and identity refusal, excess
database grant refusal, fee-key non-read, and bounded child shutdown with redacted
logs. A new native negative case changes IDL bytes and requires rejection.
Original fixture inputs and every output artifact hash are rechecked at completion.
All 16 checks passed; no check was skipped. The selected local PostgreSQL is
**18.6 (Homebrew)**, not hosted CI's PostgreSQL 16. The native run uses pinned Node
24.19.0 and a Unix-socket-only temporary cluster with durability settings checked.
Its owned cluster is stopped by the test's mandatory cleanup. Strict TypeScript
and Python syntax checks also passed. The local release build used Rust 1.90.0
with locked, offline dependencies; deployed service and immutable consumer
binaries were not replaced.

The original hosted failure log remains retained. The attempted aggregate
artifact download failed, so no independent aggregate artifact verification is
claimed. Exact source, input, output, result and failure hashes are recorded in
[PD-offline-challenger-ci-fixture.json](PD-offline-challenger-ci-fixture.json).
