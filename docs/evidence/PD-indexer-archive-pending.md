# Indexer archive-pending HTTP wait candidate

This record covers a local correction for intermittent HTTP 503 responses while the archive follower waits for the writer's next authenticated prefix. The Linux candidate is verified locally; deployment and post-deployment availability remain pending in this record. The [machine-readable record](PD-indexer-archive-pending.json) pins the source, logs and retained observations.

## Observed behavior

At 2026-10-08 04:16:00–04:16:12 UTC, twelve bounded loopback requests to the existing follower returned **nine HTTP 503 responses and three HTTP 200 responses**. Successful responses reported slots 508692893, 508692893 and 508692923. The collector checked response shape, size and hashes; it did not independently authenticate those roots against finalized chain accounts. The original processes and configurations remained unchanged, admission remained disabled, and the sampler made no direct RPC requests.

Earlier read-only checks narrowed the diagnosis:

- Three RPC reads at 03:55:30 UTC passed the deployed account-layout, identity and anchor self-consistency checks at slot 508687745. This was not full replay reconciliation.
- A bounded comparison of the saved account-cut anchor with one captured committed archive prefix matched its blockhash, parent slot and previous blockhash. It read 399 chunks / 226,273,494 bytes in 11.436 seconds, with no new RPC call or runtime-state write. This was not native full-prefix validation.
- The two-minute log observation at 04:12:38 UTC contained 38 generic reconciliation pauses, 32 distinct next-slot values and 493 slots of progress, with no captured panic marker. Cursor movement alone did not establish successful publications; the later twelve-request sample demonstrated intermittent HTTP availability.

The observed follower binary was `7b2a41955e8a280a74235611388225a1b459b8bea73dfc2a4cd0b5ca955afce8`; the separate writer was `3893ca8fe2bbdb1275e6d8faea24a918f24192ccd7daa584b6baa8a28a4df2d8`.

## Source correction and boundary

Before this change, every unsuccessful refresh cleared `refreshing`, notified HTTP waiters and slept for two seconds. This included an authenticated local archive that had not yet reached the retained target or account cut. A waiter therefore returned 503 at that intermediate result instead of using the remainder of its existing twenty-second deadline.

The correction adds a private typed `ArchivePending` result at only the empty/behind authenticated-prefix sites in [runtime_archive.rs](../../services/indexer/src/runtime_archive.rs). The worker in [runtime.rs](../../services/indexer/src/runtime.rs) keeps the logical refresh pending across its existing polling sleeps only for that concrete type. Matching error text cannot acquire the classification. The previous publication remains unavailable throughout; a request can return only a later successfully reconciled cut, or 503 when its original deadline expires.

RPC, source-corruption, replay, missing-target, expired-cut, account/anchor and worker-loss failures keep their existing rejection behavior. The account-cut freshness rule, exact replay target, final source validation, two-second polling interval and twenty-second HTTP deadline are unchanged. There is no additional RPC call, history skip, old-root fallback, journal-format change or client-release change. The preceding bounded diagnostic functions and events remain byte-identical within these two edited files.

## Local verification

All checks used Rust 1.90.0 with locked offline dependencies where applicable:

- **16 runtime unit tests passed**, zero failures/ignored, in 0.12 seconds. Five added tests cover typed empty/partial prefixes, source/replay/missing-target failures, pending-to-new-cut publication, one fixed deadline despite repeated notifications, and pending-to-hard-error rejection.
- **17 runtime integration tests passed**, zero failures/ignored, in 0.10 seconds. These include actual loopback account-cut/replay fixtures, corruption and incomplete-history cases, and the no-full-block-RPC fallback checks.
- The indexer formatter check and all-target Clippy with `-D warnings` passed. Clippy completed in 1.52 seconds.
- Independent read-only review found no blocking issue. It did not rerun the tests or perform host actions.

The source freeze is `888f10098695624b3845a141d3dd3aeebec5814406a2c209e59afebe71f2c2c3`; source-file and log hashes are retained in the companion JSON.

The isolated Linux candidate is **12,709,360 bytes**, SHA-256 `8237fdbcbb671eb9956e8b11ab470df21ae227cf9ba6dc862ad66e879aee1216`. All **187 copied source inputs** matched manifest `8f1219ebd7559b1e75c6be87fa0ea77fbb50c6ce523725e247fa58fae91659ea`. Only the two named source files differ from the retained deployed-follower snapshot; the other 185 copied inputs stay pinned. This is not an entire current working-tree build.

Network-disabled smoke checks returned the expected exit codes: 2 without configuration and 1 for archive mode with a missing configuration. Shared libraries resolved and the highest required GLIBC version was 2.34. Build, smoke and test joins are pinned by verification record `604bd17efe3ea3f343b4af385fa4de130b2efef81592c991ebd25cc9a4b82638`. These are local candidate checks, not a service-start or post-deployment availability result.

## Preserved failures and separate candidates

The first anchor-probe request was rejected before command creation because its SSM Comment exceeded 100 characters; parsing the empty rejected output also failed. The next probe stopped at head capture, before reading any chunk, because its helper incorrectly required an explicitly empty inline archive that the existing v2 serializer omits. Both observations are retained. The corrected probe accepts omitted or empty inline archive according to the existing format, still rejects null/nonempty values, and produced the bounded successful comparison above.

The earlier diagnostics-only binary `759e72536250fe16aa55b87b0762009c226275d9be5b4165317aaa3c023c99f0` and its unused transfer/sidecar preparations remain separate historical candidates. They are not described as deployed or as the source of the observed root responses.

This record makes no full hosted-CI, public-readiness, funded browser/native/OpenClaw lifecycle, or provider-acceptance claim. No financial action is established by these read-only observations or local checks.
