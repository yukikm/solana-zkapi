# Challenger archive migration on the preview host

Recorded 2026-10-08 JST. The explicitly reviewed challenger candidate completed the same-authority archive migration and a separate fresh-process cold-open on the preview host. The final read-only cut at 2026-10-07 20:26:40 UTC verified that control and challenger remained stopped and new admissions remained disabled. The [machine-readable evidence](PD-challenger-segmented-migration.json) records the exact hashes and observed metrics; [local candidate tests and build](PD-challenger-segmented-candidate.md) remain a separate scope.

The migration retained all 29,844 full blocks in 117 immutable chunks. The original 2,912,440,894-byte journal and retained v1 backup have the same SHA256, `fbec86b6c8dfd6ddda5ee9aaa9c6be408098440449720b57baedd4042e37aa2b`. Native migration validated the original typed checksum, pool, complete archive and job invariants before activation, and emitted its count/digest report afterward. The existing owner-lock device/inode remained `66305:1179655`; the configuration hash remained unchanged.

The v2 primary raw SHA256 is `ab82591dc87c46e50ece3afa1fc59afe6a6013c71ca9a8b0688679548daa3da6`. Its domain-separated typed head digest is recorded independently in the JSON. Cold-open revalidated the retained legacy prefix, complete chunk chain, checksums and mutable state, replayed to the same finalized slot 508550323, and left the primary hash and block/chunk counts unchanged. Pending jobs, unknown signatures and completed jobs were zero. The retained backup, chunks and small head occupy 5,824,957,378 logical bytes.

| Offline child | Exit | Elapsed seconds | Maximum observed process HWM | Minimum sampled host available memory |
| --- | ---: | ---: | ---: | ---: |
| Explicit migration | 0 | 199.349 | 1,846,886,400 bytes | 1,597,960,192 bytes |
| Fresh cold-open/status | 0 | 212.358 | 1,855,070,208 bytes | 1,627,734,016 bytes |

Both children used the exact Linux binary SHA256 `271628332f24c0d60eb1bc105bf372e8a418aab2e87e002168e3f2ce1c80b0fe`, ran in verified isolated network namespaces, and produced no stderr. No cancellation signal, automatic retry, rollback, history pruning or orphan-tail adoption occurred. The completed transient unit was subsequently garbage-collected; its later default systemd properties are not evidence of its execution policy.

This records offline storage migration and cold validation only. Catch-up and live acceptance had not resumed at this checkpoint. The candidate still retained one complete history Vec, with a measured cold-open baseline near 1.86 GB before the remaining catch-up. A separate disk-backed reader is being evaluated without changing the committed v2 format. These sampled memory observations do not establish a cgroup peak, sustained 4GiB capacity, production availability or a funded/provider lifecycle pass.
