# Challenger disk-backed archive reader: local candidate

Recorded 2026-10-08 JST. The frozen reader candidate removes the remaining resident v2 block-history Vec. It retains a verified chunk index and small tail, reading full blocks one authenticated chunk at a time. Existing v2 files need no migration or rewrite; v1 remains the default initialization format. The [machine-readable report](PD-challenger-disk-reader-candidate.json) pins the source, local checks and Linux binary. The [original segmented candidate](PD-challenger-segmented-candidate.md) and its [actual same-authority migration](PD-challenger-segmented-migration.md) remain separate historical records.

Cold open validates every committed chunk's exact bytes, count, pool, sequence and parent link, then verifies the complete original prefix against the retained v1 backup before runtime replay or RPC construction. Ordered replay revalidates each chunk before passing borrowed blocks to the Scanner. Callback errors stop subsequent callbacks. Historical timestamp and duplicate checks load the matching chunk; skipped slots return no result and duplicates must match the complete block, including transaction data.

Appending retains only the bounded new suffix while validating it. New chunks and the small primary head reach durable storage before the in-memory index/tail or Scanner advances. Persistence failures still poison further writes, and reopening follows only committed references. Orphan retention, exact legacy-prefix binding, owner locking and financial/recovery semantics remain unchanged. Independent source review found no blocking issue.

The exact source passed these serial local scopes:

| Scope | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| Ordinary unit suite | 52 | 0 | 12 |
| Actual CLI migration/refusal fixtures | 2 | 0 | 0 |
| Saved-SBF coherent-cut fixtures, including v2 replay/restart | 3 | 0 | 0 |
| Explicit shutdown/persistence fixture | 1 | 0 | 0 |

The latter two runs explicitly exercise selected ignored tests; these overlapping scopes do not mean every ignored test ran. Counts include child-harness entrypoints. The focused journal suite separately passed 21 tests, followed by a one-test correction that makes the substitution fixture target exact instruction payload bytes. Full serial validation used the final unchanged source.

The first full unit invocation used parallel execution and recorded 50 passes, two owner-lock conflicts and 12 ignored tests. Both conflicts occurred during immediate reacquisition of separate temporary fixture journals. A deterministic temporary OS fixture showed that a child before `exec` can retain an inherited flock after the parent closes its descriptor, despite close-on-exec. This demonstrates a mechanism consistent with the failures, not a trace identifying their exact child. The repository's existing challenger runner uses `--test-threads=1`; serial validation passed without production changes, lock retries or weaker ownership checks. The failed parallel report is retained.

A fresh-process synthetic check generated history in small batches and measured cold-open plus complete ordered replay:

| Full instruction payload retained on disk | Blocks / chunks | Process peak RSS |
| --- | ---: | ---: |
| 8,388,608 bytes | 16 / 1 | 20,529,152 bytes |
| 67,108,864 bytes | 128 / 8 | 21,299,200 bytes |

This demonstrates that the reader does not retain those historical payloads in memory. It does not model a complete live operator. Chunk-reference and accepted-block digest metadata still grow, Scanner clones remain, and the existing oversized-single-block exception can exceed the nominal chunk budget. Cold open rereads history to preserve complete validation before replay.

All 182 current source files and copied build inputs independently matched source-manifest SHA256 `3d2c0edacac02247ee083aad10ce1a3ac83b5827603bca09ffbb00d7bc78e945`. Ten source/test files changed from the segmented snapshot; no new dependency version was added. The Linux x86_64 release build took 118 seconds with Rust 1.90.0 in Amazon Linux 2023. The binary is 11,669,872 bytes, SHA256 `c73d58baebb1ad0d992ba63ca0827af4fb9636d93985440c9dffdd98e9fb7ac2`; maximum required GLIBC symbol is 2.34 and the no-config smoke returned the expected usage exit 2.

This report establishes local tests, source review and a built candidate. Installation, same-archive host cold-open, resumed catch-up and public lifecycle acceptance require separate observations. It makes no long-term 4GiB capacity, production availability, provider or funded-acceptance claim.
