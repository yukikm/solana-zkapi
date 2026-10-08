# N-01 service recovery — same-state restart complete

Latest checkpoint — 2026-10-08 11:45 UTC: **admission resumed successfully**
after the [writer namespace correction](PD-rpc-program-log.md), a fresh installed-native
preflight and an independent operator cut. Run06 completed at 11:44:52.783 UTC.
Both original full local readiness checks passed on their first attempt, taking
12,159 ms and 11,770 ms. The separately reviewed invocation wrapper preserved
the original checks and 120-second freshness rules; it allowed 40 seconds for
a check while limiting the start of additional health-only retries to ten seconds.
No readiness retry was used in this successful invocation.

The public response at 11:45:51 UTC returned HTTP 200 with admission and recovery
enabled. Its explicit scope is `relay_configuration_only`: readiness, signer,
provider credit and finalized Pool are `not_checked` by this endpoint. This is
not a continuous availability or provider-credit guarantee. A later read-only fetch at 11:59:50 UTC independently retained the exact
2,817-byte native result with SHA-256
`5717d7436cbf5b8069caeea9800db35fe21261a44bca949542cca80ae665a145`.
Its raw-byte hash is distinct from the normalized SSM completion output; this
retrieval did not occur at the earlier 11:45 public observation. The receipt
confirms that only `allowNewAdmissions` changed, the other five service
processes were unchanged, and the transition's retained budget cut still had
one reservation. It does not establish a post-OpenClaw budget observation.

The first local receipt-fetch preparation had an output-name collision between
the raw receipt and its summary, identified before host dispatch. The separately
retained v2 changes only the summary filename. An actual temporary-filesystem
finish test passed exact raw-byte preservation, distinct summary hashes and
create-only output checks; the generated host request bytes stayed unchanged.

The pre-resume operator cut still had one N-01 reservation of 1,000,000 micro-USDC,
one signed settlement charging six micro-USDC, all seven terminal checkpoint
rows retained and zero unresolved work. N-01's signed active balance remained
4,999,994 micro-USDC. Root launched N-02/N-03 around 11:48 UTC; those later
outcomes and any resulting reservations or charges are outside this checkpoint.
N-04, funded browser acceptance, withdrawal and independent backup download,
decryption and restore remain unverified. The new public readiness candidate
has not been deployed.

Earlier attempts remain distinct: run01 transferred reviewed inputs but the
local dispatch-margin guard refused invocation; runs02 and03 failed their
initial read-only readiness check before the coordinator or gateway stop;
run04's local assembler refused an operator clock one second ahead, before
approval or transfer; run05's ten-second wrapper deadline interrupted the
original bounded indexer read before any coordinator or gateway stop. Run06
used a fresh cut, review and explicit successor wrapper. No old invocation was
replayed, no reservation was reset, and no timestamp was rewritten. The two
already transferred, content-addressed client/settlement evidence files were
reused only after exact owner, mode, identity and byte checks; the fresh review,
join and preflight files remained create-only.

## Historical checkpoint through 09:40 UTC

Date: 2026-10-08 UTC. The encrypted capture completed at 08:54 UTC and the
guarded same-state restart completed at 08:59 UTC. **Fresh service readiness
and admission resume are blocked by a later archive-decoding failure**. The [receipt index](PD-N01-service-recovery.json)
retains the exact hashes and earlier failed observations.

After the [N-01 settlement and independent operator join](PD-N01-operator-join.md),
admission was suspended. A public read at 07:58:49 UTC returned HTTP 200 with
admission suspended and recovery enabled. The one full-cap reservation and
six-micro-USDC charge remained distinct; all seven terminal checkpoint rows
were retained, with zero unresolved work. The maintenance review included
95 source/evidence pins, including the backup recipient certificate.

The first capture failed after stopping gateway, control, challenger, signer
and PostgreSQL and saving the database dumps, before creating an inventory or
ciphertext. Read-only diagnosis found an existing empty, root-owned `lost+found`
directory outside the helper's directory allowlist. Thirteen original prefix
files, including the failure and stop receipts, remain unchanged. The archive
follower stayed running. Cleared native exit metadata is not reconstructed.

The explicitly approved continuation included that exact empty directory and
all retained prefix evidence in the encrypted archive. It repeated no service
stops or database dumps. The completed capture produced **3,531,572,566 bytes**
of ciphertext with SHA-256
`18df502fdc9665f263e6c5252875bc1b24a872d2d99432953387864738426234`.
Inventory equality, the existing authority lock and reservation identity were
preserved. A single conditional upload returned the expected checksum and a
nonempty object version. This confirms the upload response; an independent
download, decryption and restore test have not occurred.

The continuation stayed within the existing 5 GB file limit, with core dumps
disabled and the minimum 6 GB free-root-space guard. Its successful receipt and
the capture receipt were fetched read-only, preserving their exact raw bytes.
The single restart bound those receipts and the original failed prefix. The
unchanged helper passed saved-inventory, ciphertext, authority/reservation and
database-cut equality guards before starting the five original services from
the same state. It did not restore from the encrypted backup.

A separate 09:01 UTC read-only observation found all six services active, zero
automatic restarts and the original archive follower process unchanged. The
challenger still exposed its older, non-ready health cut, so process startup is
not a fresh-readiness result. Admission remained suspended. Available memory
was 3,280,388 KiB, with 16,521,293,824 bytes free on the data volume and
14,835,838,976 bytes on the root volume at that observation.

A later 09:40:40 UTC diagnostic showed that cold replay had ended, but the writer
was paused at durable tail `508763135` with fresh non-ready health and repeated
`RPC archive encoding` errors. All 20 matching recent pause messages had that
static category; pending jobs and unknown signatures remained zero. The actual
next-slot `508763136` RPC response is retained with SHA-256
`6879724d1772f0fec161b5c2d2cbfd94ce74738eabccb522de8caba68608506d`.
The frozen old native decoder rejects only transaction 17: application
`Program log: ` text containing ` failed:` is mistakenly interpreted as a runtime
completion. A narrow namespace correction is under local verification; no
deployed correction is claimed. This later blocker does not erase the completed
capture or restart; it prevents a fresh readiness and
admission-resume claim. N-01 remains settled with its active note, and no further
paid acceptance case has run.

The three continuation, four restart-wrapper and four receipt-fetch local test
groups are preparation checks. No new inference, AUTH, reservation reset,
backup restore, withdrawal or completed service-recovery acceptance is claimed.
The inventory quiet window was retained through restart validation. Fresh
preflight and independent operator observations are still required before any
admission resume. Earlier setup and classification failures retain their
original scope.
