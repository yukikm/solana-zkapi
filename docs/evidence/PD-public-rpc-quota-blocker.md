# Public Devnet RPC quota blocker

Recorded 2026-10-08 JST, through 2026-10-07 22:51:34 UTC. This is a new
read-only checkpoint following the [shared archive indexer host observations](PD-shared-archive-indexer-host.md).
The earlier checkpoint remains unchanged. [Exact redacted results and input hashes](PD-public-rpc-quota-blocker.json)
retain both the quota failure and the unsuccessful free fallback sample.

The configured RPC stopped supplying the archive. Existing logs showed HTTP
429 responses for `getBlock`, `getBlocks` and even `getGenesisHash`. One
authorized genesis-only probe returned an actual JSON error message classified
as **monthly quota wording**, with HTTP status and numeric RPC error code 429.
The classification used the saved message, rather than inferring the cause
from status 429. The complete 197-byte response and headers remain private;
account identity, payment details, private endpoint and account usage totals
are omitted. No quota reset date or attribution of all account usage follows.

The official free endpoint, `https://api.devnet.solana.com`, passed the genesis
join and matched the saved archive tail's block hash at slot `508591968`.
It listed all eight subsequent slots as produced. Five full blocks then
passed sequential parent/hash joins and structural JSON checks, including
legacy, v0 and v1 transaction shapes. The sixth full block, slot `508591974`,
returned HTTP 429. The probe stopped immediately: nine total requests,
at least 0.4 seconds between request starts, 472,983 response bytes and no
retry or redirect. Native block decoding was not executed.

This sample does not establish sustainable catch-up on the free endpoint.
[Solana's published public-endpoint limits](https://solana.com/docs/references/clusters)
include 40 requests per method per 10 seconds per IP, and expressly may
change. They are not a guaranteed operating rate. The observed rejection
occurred within this small paced sample, so no endpoint switch or higher-rate
experiment was justified by it.

At the last local service cut, 22:45:48 UTC, the same writer and follower
processes were active, but root and snapshot endpoints returned 503. The
archive retained 71,115 blocks through slot `508591968`; reported finalized
lag was 4,273 seconds, with zero pending jobs or unknown signatures. Control
remained stopped and new admission disabled. Available memory was 3.345 GB
and data-volume space 9.908 GB. The disk notification was recorded without
deleting history. CPU credits were 20.61 at the latest 22:35 sample; these
observations do not show CPU-credit exhaustion or establish sustained capacity.

No services were restarted, no transport configuration was changed, and no
funding, AUTH, inference, paid upgrade or new provider account was created by
this checkpoint. The saved original start slot, archive and financial state
remain preserved. Further probing and the conditional control-start sequence
are held pending an authorized RPC choice and actual readiness evidence.
