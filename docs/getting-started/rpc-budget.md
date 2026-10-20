# Reduce operator RPC consumption

The implemented replacement is [Pool-scoped current-state synchronization](../specs/pool-history.md),
with a [fresh PoC setup contract](poc-state-sync.md). It removes complete-history
acquisition and duplicate idle chain reads. Its modeled idle one-batch estimate
is 580,320 sync/identity calls per 31 days before startup, retries and user work;
applied method prices determine credits. See that guide for the current configuration, method-count tests and limits.

The instructions and calculator below describe **the retained legacy full-history
utilities**, not the replacement's configuration or cost. Projection/compaction and
slower polling alone cannot remove that runtime's per-produced-block floor.

This source-build configuration reduces redundant background reads while retaining
complete finalized history and independent account/block-anchor validation. It is
not a deployment, billing change, production availability claim or spending grant.
Check [support](../support.md) and preserve the existing funded profiles, journals,
archive, deployment pins and recovery material.

## Use one archive writer

Use the existing challenger archive writer and the
[archive-backed indexer](archive-storage.md). A separate RPC indexer fetches the
same full history again. A local archive follower still reads finalized accounts
and an independent block anchor; it never fills a missing local block from RPC.
Do not replace or reset an existing journal to adopt this topology.

Warm scans use the finalized account response to choose their target slot. They
still replay every produced block through that slot, including all closed/reused
buffer history and CPI, before validating accounts. A changed account inventory,
incomplete history, inconsistent cut or anchor mismatch keeps the service
unavailable. No validated account result is cached across refreshes. Empty
challenger recovery does not contact RPC; every recovery with an Unknown attempt
still authenticates genesis before any transport call.

## Configure background cadence

After building matching server binaries from this source, these are **field
updates to existing private configurations**, not replacement configuration files:

| Configuration | Field | Suggested value | Accepted range / omitted default |
| --- | --- | ---: | --- |
| Challenger writer | `poll_seconds` | `10` | 1–30 / required |
| Indexer (also inside archive-backed config) | `poll_seconds` | `10` | 1–10 / 2 |
| Each control service | `background_recovery_seconds` | `10` | 1–10 / 2 |

Only change these fields in an approved server update. Preserve every other
configuration field, secret and state path. Older binaries may reject the new
fields. Published SDK/native releases are immutable and need not be replaced for
this server-only change. Existing two-second defaults remain compatible.

Ten seconds reduces recurring overhead but adds detection/recovery latency.
Request authorization still performs its fresh dual-RPC checks; this setting
does not cache nullifier/Pool state, replay inference or replace Unknown signed
transactions. Indexer HTTP waits remain bounded to 25 seconds, held archive cuts
expire after 30 seconds, and existing readiness age/deadline checks still apply.
Slow catch-up or RPC failure can therefore make the service unavailable. Do not
raise freshness limits or disable the challenger to meet a credit target.

The control timer skips missed ticks after a slow call instead of issuing a
burst of background checks. Challenger/indexer delays occur after each attempt;
larger intervals do not reduce the number of historical blocks required.

## Estimate the monthly floor

The Developer allowance used here is 10,000,000 credits. Confirm the **applied
per-method rate for the account**: the official
[credit table](https://www.helius.dev/docs/billing/credits) lists `getBlock` and
`getBlocks` at one credit, while the
[pricing FAQ](https://www.helius.dev/pricing) describes archival requests at ten
credits (conflicting documentation observed 2026-10-18). The estimate requires
that rate explicitly and is not evidence of what an account was billed.

For one writer, one local follower, one control process, a single account batch,
and a **hypothetical** two produced blocks per second:

```sh
python3 scripts/rpc_budget.py --blocks-per-second 2 --archive-credits 1
```

The default 31-day, ten-second estimate is **7,767,360 credits**, including
5,356,800 full-block reads. At 2.5 produced blocks/second it is **9,106,560**,
which fails the tool's default 20% headroom target. At ten credits per archival
request, even the full-history floor alone exceeds the Developer allowance.
These rates are examples, not measured Devnet throughput. Slowing polls cannot
remove the complete-history floor without a separate validated evidence/trust
design.

Set `--control-processes` to the actual number of services and
`--account-batches` for account inventories over 100 addresses. The calculator
conservatively charges both control RPC origins to the same allowance. Include
remaining historical blocks using `--backlog-blocks`, and allow for user activity,
monitoring, readiness requests, retries, additional range reads and other
consumers with `--extra-credits-per-day`. The backlog option counts full-block
reads only; add its range/retry costs to the extra allowance. Defaults of zero
for these inputs do not mean those costs vanish. This estimate neither sets a
hard request limit nor pauses security work on budget exhaustion.

## Measure after an approved rollout

Native archive, control, readiness and monitoring HTTP boundaries emit a
`rpc_usage` JSON event to stderr at most once per 60 seconds **when another
request occurs**. Counters are cumulative for that process/counter instance and
include failed HTTP attempts. They contain fixed method/component labels,
process/instance IDs, elapsed milliseconds and counts; no URL, API key, address,
request body or response body. `getBlock_full` and `getBlock_anchor` are separate.
There is no telemetry service or extra RPC request. Processes that exit or go
idle before the reporting interval may have no final event.

Use deltas of two samples from the same process invocation and instance:
`delta_count / (delta_elapsed_ms / 1000)`. Sum across the actual daemons; do not
sum cumulative samples or join counters across process restarts. Archive counters
identify the writer/follower via the service log, not a private endpoint label.
Control primary/secondary labels identify endpoint roles, not billing accounts.
SDK, Node bridge, external health probes and other processes are not covered by
these native counters; include their traffic from provider metrics.

Measure steady state separately from catch-up, and reconcile method totals with
provider Usage before treating a budget estimate as operational evidence. Retain
private samples under ignored `target/` or the operator's private log store.
If the measured full-history floor exceeds the allowance, these optimizations
alone cannot make that deployment fit while retaining its current safety model.
