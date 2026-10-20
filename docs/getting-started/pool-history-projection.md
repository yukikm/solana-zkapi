# Measure a Pool-specific history projection offline

The source-built `challengerd project-history` command implements the offline
part of [candidate A](../specs/pool-history.md). It validates complete original
blocks, writes only whole relevant transactions plus block coverage to a **new**
directory, compares full replay semantics at every block, and independently
rereads the output before publishing its manifest. No RPC, database connection,
journal writer, fee key, proof generation or financial transport is constructed.

This is a shadow artifact, not a deployed storage upgrade. The running challenger
and archive indexer still use the complete original archive. Projected replay
cannot become ready, serve paths, create a financial view or write a legacy
restart checkpoint. Existing archives, financial journals, custody and published
SDK/native packages remain unchanged. Check [support](../support.md).

## Prepare a bounded output

Build with the pinned toolchain:

```sh
cargo +1.90.0 build --locked --manifest-path services/challenger/Cargo.toml --bin challengerd
```

Use the existing independently pinned manifest and the complete retained v2
archive. `start_slot` must retain its original value at or before initialization.
The dedicated offline configuration has no RPC URL, database DSN or fee key:

```json
{
  "manifest": "/trusted/deployment/manifest.json",
  "manifest_sha256": "<independently pinned manifest hash>",
  "start_slot": 1,
  "source": {
    "kind": "archive_v2",
    "directory": "/private/challenger-journal"
  },
  "output_directory": "/private/offline-measurements/new-pool-history",
  "max_output_bytes": 1073741824,
  "chunk_blocks": 256,
  "chunk_bytes": 8388608
}
```

For a Devnet manifest, add the same explicit `devnet` object with the original
IDL, program, build-manifest and independent build hash used by the existing
[challenger configuration](../../services/challenger/README.md). Do not substitute
a local profile or newly generated Pool. Preserve all deployment pins.

The output parent must exist. The output directory must be new and outside the
source; aliases and ancestor overlap are rejected. Its total byte budget is
explicit, with an additional 2 GiB plus 32 MiB free-space reserve. Existing output
is never overwritten or automatically resumed. Single blocks over the offline
32 MiB bound fail without pruning the source. Chunk limits are 1–256 blocks and
at most 32 MiB of original decoded block bytes; an allowed larger singleton is
kept together. The default is 64 blocks; use 256 for large retained archives.
An early metadata-capacity estimate rejects configurations whose block count
would exceed the 16 MiB manifest bound. Byte-triggered additional segments can
still reach that bound later; decoded-record bounds also apply.

Cold opening the retained archive authenticates its entire prefix. This can take
substantial I/O and memory even if the Pool has few operations. Prefer an isolated
read-only copy when recovery is consuming the same host. Do not restart a healthy
recovering writer to run a measurement. The reader captures one committed head;
newer writer commits do not change that export's cut.

## Export and interpret the report

```sh
services/challenger/target/debug/challengerd project-history /private/projection.json
```

Save the JSON report and configuration privately under ignored `target/` or the
operator's private evidence store. Retain the returned `manifest_sha256`
separately. The output contains immutable content-addressed gzip segments and a
manifest binding the source, Pool, validator binary, rules and exact covered cut.
It preserves original transaction indices, instruction/CPI positions and block
headers. Buffer generations are never renumbered.

The exporter compares configuration, tree/Active/Pending state, outstanding
value, exit nullifiers, complete open buffers, ordered transitions, accepted
slot coverage, scanner generations and time. It compares again after reading
the compressed output into a new scanner. The source archive's immutable file
identities are rechecked before completion. This is evidence equivalence under
the existing trusted archive model, not independent proof of RPC completeness
or a fresh finalized account observation.

| Report field | Meaning |
|---|---|
| `blocks_verified` | Complete source blocks replayed, including blocks with no selected transactions |
| `original_transactions` / `selected_transactions` | Transaction counts before and after projection |
| `full_equivalent_gzip_bytes` | Complete decoded blocks compressed with the same segment boundaries, envelope and gzip level as the candidate |
| `projected_gzip_bytes` | Actual compressed projected segment bytes |
| `manifest_bytes` / `artifact_bytes` | Metadata bytes and total new candidate bytes |
| `saved_bytes` | Full equivalent compressed bytes minus total candidate bytes; negative means expansion |
| `semantic_sha256` | Complete final shadow comparison commitment, not just the Merkle root |
| `source_preserved` / `live_activation` | Successful source-preservation checks; activation is always false |

The baseline is a comparable re-encoding, not the exact occupied size of the
existing v2 archive. Small histories consisting mostly of relevant transactions
can expand because the projection adds binding/coverage metadata. Report that
result rather than comparing compressed output with uncompressed input. Samples
of unrelated blocks alone cannot establish a whole-archive saving. Existing
retained bytes and temporary output still count toward disk usage.

The original source remains unchanged on validation, space or I/O failure.
Failures before final publication leave no completed manifest. An interruption
or error during the final rename or directory sync can leave a visible manifest
with uncertain durability. Inspect and verify any such artifact against the
independently retained manifest pin before using it. Keep partial output for
inspection; do not automatically delete it or repeat an uncertain operation at
the same destination.
An interrupted shadow export cannot resolve an Unknown financial attempt.

## Reproduce offline acceptance

Generate the existing local SDK/SBF history using `bash scripts/run_i04.sh`, then
run the focused checks:

```sh
cargo +1.90.0 test --locked --manifest-path services/indexer/Cargo.toml projection
cargo +1.90.0 test --locked --manifest-path services/challenger/Cargo.toml --lib projection_archive
cargo +1.90.0 test --locked --manifest-path services/challenger/Cargo.toml --lib tests::projection -- --ignored
```

The SBF tests use all four retained lifecycle scenarios and separately exercise
missing events, inserted foreign transactions, original Pending positions and
restart at every cut. The fixture's transactions were executed by local SBF;
slot finality is synthetic. Corruption, CPI failures, gaps, duplicate content,
foreign-data rejection and storage failures use synthetic adversarial fixtures.
These tests do not perform public funded transactions or inference.

For measurement of a generated SBF fixture, replace `source` with
`{"kind":"sbf_fixture","path":"/absolute/generated/sdk-svm-history.json","scenario":"challenge"}`
and use its matching local pinned manifest and start slot. Raw block envelopes
still pass the complete existing RPC decoder; the source hash and synthetic
scope are recorded in the artifact.

The selected [fresh PoC design](../specs/pool-history.md) uses current accounts
instead of a projected history suffix. This offline command is not a prerequisite
for that runtime or its reset. It does not reduce current RPC requests or release
space occupied by existing history.
