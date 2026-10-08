# Public runtime and independent browser-origin follow-up

Observation cutoff: 2026-10-08 05:32:43 UTC. Later admission or funded actions
are outside this read-only readiness checkpoint.

The authenticated archive-prefix wait fix is installed in the public indexer.
Its retained receipts join the clean native exit-zero stop at 04:28 UTC,
installation at 04:30 and restart at 04:35 on 2026-10-08. Binary
`8237fdbcbb671eb9956e8b11ab470df21ae227cf9ba6dc862ad66e879aee1216`
contains the reviewed bounded-wait correction and diagnostics. The original
start slot `508520236`, writer process, configuration, retained snapshots,
financial identity and zero-reservation state were preserved. Startup is not
proof of completed replay or service readiness.

A separate static CloudFront origin,
[the independent browser check page](https://d30nr98svcwdoe.cloudfront.net/releases/public-devnet-20261008-a/pd04-check-v1/index.html),
was published through distribution `E2NJ6KOTSQGG11`. Five new files were uploaded
without overwrite, index last. Nine anonymous HTTPS GETs verified seven exact
files (including the existing English app index and notices); `/rpc` and the
original profile path on this static origin returned 403. Normal TLS validation
passed, without redirects or automatic retries. Those initial observations are download checks. A separate actual browser
run is recorded below; it does not retroactively broaden the download scope.

The stopped gateway's reviewed configuration gained only this additional
`allowedBrowserOrigins` entry. Its before-image was retained and admission stayed
false; no service was started by that configuration operation. The separately
versioned v5 maintenance/collection/admission sources were installed under new
names, root-only, with earlier sources and receipts unchanged. Installing those
sources did not import or execute them and performed no admission, financial or
service action.

The deployed CloudFormation template is the retained `template.json` from the
independent-origin preparation, SHA
`60ba2b14c2d6f9ab46fdbb34a305d3679c3278cfa017a805f17ad76601d9aff8`.
It retains the 40 GiB data volume and adds the independent distribution. The
reviewed source template `deploy/public-devnet/aws-budget-host.json` is now
`c49a35cb497d653f9035b1e4cb9a9c179c93d4562daee05bc4da30c0f57d4391`: it
includes the 40 GiB volume and actual independent-distribution/policy/outputs
while preserving the working pinned-RPM NAT bootstrap. The exact deployed
`60ba2b` snapshot is retained separately; it still carries the older dnf
bootstrap metadata because the running NAT was repaired through SSM and the
improved source was not reapplied to that resource. The independent-origin
update itself preserved the actual preexisting NAT resource. The source
promotion performs no AWS action; any later CloudFormation application needs
an explicit review of these known source-versus-stack differences. This static addition creates no new compute instance or NAT;
variable CloudFront/S3 charges remain within the existing budget target's
limitations, not an automatic USD50 cap.

At the retained 04:58–04:59 UTC observation, writer health reported ready with
zero-second lag, while the newly started follower returned 503 after the bounded
20-second wait on both root and snapshot requests during initial replay.
Admission remained false. At the next retained cut, 05:09:44–05:09:48 UTC,
root returned HTTP200 in 3.667 seconds and snapshot returned HTTP200 in 0.004
seconds. The archive had 184,709 blocks / 4,320 chunks, tail slot 508706420;
writer health was fresh and ready. This is the first bounded follower response
success, separate from six-service readiness, public comparison and installed-SDK
checks. Subsequent public and browser results are recorded below. Funded
lifecycle and full hosted-CI success are not claimed.

Control then started at 05:10 UTC, and the original challenger service unit was
restored at 05:11 without starting or restarting a process. The first gateway
start attempt at 05:13 failed its writer-readiness guard before starting the
gateway; this failed observation remains preserved.

Twelve later loopback root samples from 05:14:13 to 05:15:02 all returned
HTTP200 with validated response shape, advancing from slot 508707525 to
508707740. Requests took 0.003–7.526 seconds. Six process identities and their
configuration pins stayed unchanged and admission remained false. These are
bounded local availability samples, not independent chain authentication or
public SDK acceptance. In observations 10–12 the separate writer health was
briefly ready=false with two-second finalized lag and zero pending jobs/unknown
signatures; the final writer observation was ready=true. Do not infer continuous
writer health or six-service readiness from the twelve indexer responses.

A separate read-only cut at 05:19 found fresh writer health ready with zero
proof failures. The bounded historical log window retained 15 static
“RPC finalized tail missing” entries; it did not establish a current proof
failure. Root's explicit gateway-start continuation succeeded at 05:20:35,
with the other services unchanged and admission false. The original failed
preaction attempt was preserved; no automatic retry occurred.

At 05:22:29, the separate local idle-readiness collector verified all six
services active, root and snapshot at the same slot 508709609, signer
reconciliation, zero active notes/pending withdrawals, and fresh writer health.
The archive retained 187,885 blocks / 4,840 chunks through slot 508709612.
The seven-cap authority still had zero reservations and all financial database
counts were zero. Admission remained false. This local checkpoint does not
replace independent public gateway, installed-SDK chain authentication or
funded lifecycle acceptance; no peak-memory or monthly-capacity claim follows.

The public-versus-local comparison at 05:23:31–05:23:36 made thirteen bounded
GETs, all HTTP200. The pinned profile, static control/catalog values and
content-addressed snapshot matched their local counterparts at slot 508709888.
Processes were unchanged and admission remained false. That comparison itself
does not independently authenticate the chain clock.

The separate Chrome run at 05:23:00–05:23:29 used the new `d30nr98svcwdoe`
CloudFront origin and fetched the canonical API at `d366buuvadnp3`. It passed
all ten released-SDK preflight checks, including genesis, finalized Pool,
shared snapshot and chain clock, at slot 508709869. Profile SHA-256 was
`5e868f8e57ef06961b73ba8cb755635e81d4bb168dd6ad498152496ac1b02d14`;
the page used the unchanged published `.2` SDK tarball `fe9917b7…143dc`.
The published worker loaded the pinned WASM and reconstructed the known public
`layout2/a.json` fixture, rejected an invalid root, then successfully reused
the worker. This is synthetic snapshot mathematics inside a real browser;
it is not fresh proof generation or a funded account test.

The application's read instrumentation recorded 27 asset GETs, two control
GETs, two snapshot GETs and six RPC reads. These are application-level counts,
not a packet capture. Custody stayed closed, no invitation was used, and no
AUTH, inference, transaction or funding action was performed. Admission was
still reported as unverified by preflight. Observed read-only cross-origin
transport and worker execution satisfy the remaining PD-04 browser/preflight
requirement; provider CORS, settlement and the funded browser/native/OpenClaw
lifecycles remain separate. The visible JSON equals the saved DOM result, and
the reviewed screenshot contains only this public diagnostic output. The
separate installed-native SDK result is recorded below.

The installed public native consumer CLI also passed all ten checks through
direct HTTPS, at snapshot slot 508710203 / clock 1791437087. Its retained JSON
is SHA-256 `7646ef1d64c364bce0d0a3b23b7ae645c62bc65ac121a16f8c1487ce157556c0`.
Before execution, the runner authenticated release manifest `0b573371…0572ca`
and rehashed the actual Node, CLI and all installed JavaScript dependencies
(5,990 files). This preflight did not invoke clientd or a prover, open custody,
submit AUTH, infer, fund or transact. It reported operator admission as
unverified; it does not establish an enabled grant or a funded lifecycle.

The v6 operational sources were separately installed without state or service
actions. Their first read-only collector failed because its restricted PATH
omitted `/usr/sbin`, where the host provides `runuser`. The retained read-only
path diagnostic confirmed that resolution issue. The failed collection and
successful earlier preflight remain separate historical observations. No usable
collection, approval or admission enable follows from that attempt. At this cutoff, a versioned
v7 source correction and fresh preflight/collector cut were being prepared.
Their later installation, execution and any admission decision are outside this
checkpoint; an expired preflight must not be reused for admission freshness.

A separate read-only integrity check at 05:32:43 UTC rehashed all 7,257 installed
native release files (271,025,916 bytes) against the same authenticated release
manifest. Every file matched. That complete rehash read no private custody,
made no network request and performed no financial action; it is distinct from
the earlier preflight's 5,990-file execution guard and is not lifecycle acceptance.

Exact receipt, artifact and source-input hashes are in
[PD-public-runtime-origin-followup.json](PD-public-runtime-origin-followup.json).
Earlier candidate and failure evidence remains unchanged.
