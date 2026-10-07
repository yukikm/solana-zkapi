# Challenger segmented archive: local candidate

Recorded 2026-10-08 JST. The challenger now has an explicit, locally verified migration candidate that removes complete-history cloning from mutable job updates and complete-history rewriting from each archive append. The [machine-readable report](PD-challenger-segmented-candidate.json) records the exact source, test and Linux build hashes. No live journal migration is claimed here.

The original v1 format remains the initialization default. `open` detects an existing v1 or v2 file without migrating. The explicit `challengerd migrate-archive CONFIG.json` command runs before Scanner, RPC, database or signing-bridge construction. It takes the existing owner lock, validates the original pool/checksum/archive/job invariants, retains byte-identical `legacy-v1.json`, and refuses partial staging from an earlier attempt.

V2 places the retained block Vec outside cloned mutable State. New complete-block chunks are hash-linked, synced and published without replacement before the small primary head is synced and atomically activated. The caller installs its Scanner only after successful persistence. A failure poisons further writes; reopening follows only the committed head and retains unused files without adopting them. Cancellation is checked after temporary-head fsync immediately before rename. A failure after activation begins never causes an automatic rollback to the legacy file.

Cold open independently verifies the complete original archive prefix against the retained v1 file, including all transaction and instruction bytes, using a streaming canonical-block hash chain. It holds one legacy block at a time. Tests reject rechecksummed empty, truncated, shifted and transaction-modified prefixes, as well as invalid parent/count/version metadata, missing or substituted chunks, trailing JSON and symlinks. Exact pending signed attempts, transport records, jobs, alerts and legacy serialization remain covered.

The frozen source passed these separate local scopes:

| Scope | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| Ordinary unit suite | 47 | 0 | 12 |
| Actual CLI migration and refusal fixtures | 2 | 0 | 0 |
| Explicit saved-SBF coherent-cut fixtures: v1/default, v1/larger batch and v2 | 3 | 0 | 0 |
| Explicit saved-SBF shutdown/persistence fixture | 1 | 0 | 0 |

The coherent-cut and shutdown runs explicitly exercise cases ignored by the ordinary unit command. These overlapping scopes do not establish that every ignored test ran. The unit count also includes inert child entrypoints used by process fixtures. Source and copied build inputs remained unchanged across all 182 guarded files after tests and after build; source-manifest SHA256 is `8765a8533665829c734f936ea871775081b3087178b1221cb99f1f71c6be89b6`.

The Linux x86_64 candidate built in 115 seconds using Rust 1.90.0 in Amazon Linux 2023. Its binary is 11,686,688 bytes, SHA256 `271628332f24c0d60eb1bc105bf372e8a418aab2e87e002168e3f2ce1c80b0fe`. ABI inspection found maximum `GLIBC_2.34`; the no-config smoke exited with the expected usage status 2. The only dependency change adds direct Unix access to the already-locked `libc` 0.2.190; no dependency version changed.

The initial incomplete-module compile observation and earlier candidate checks remain preserved. The final tests include the subsequent cancellation-boundary, full-prefix-integrity and buffered-hashing corrections. These are local storage, process and saved-fixture results, not new public-chain, provider, funding or crash-recovery acceptance.

The full archive still resides in memory once and continues growing on disk. Migration needs temporary space for the original primary, exact retained backup and new chunks. Cold open rereads the backup and all committed chunks. This does not establish long-term capacity on a 4GiB host, a production SLO, distributed fencing or filesystem rollback detection. Host transfer, guarded migration, cold-open and resumed catch-up require separate evidence; the earlier [runtime capacity review](PD-runtime-capacity-review.md) remains historical context.
