# Replay writer successor: installed and catching up

The [batch-copy correction](PD-replay-batch-copy-20261009.md) is installed in
the public deployment's writer. Only `/opt/zkapi/bin/challengerd` was replaced
and restarted; the archive follower and other processes were preserved. The
actual installation completed at **2026-10-09 00:03:33 UTC**. Three subsequent
read-only journal-head observations measured continued catch-up. They do not
establish fresh readiness or public availability; the gateway remained stopped.
The [JSON record](PD-replay-writer-deployment-20261009.json) pins the complete
receipts and separates these scopes.

## Published source and local Linux artifact

All **194 frozen build inputs** match published source
[`8423687b0a4f441d376ddc685f5d573a4a3c1684`](https://github.com/yukikm/solana-zkapi/commit/8423687b0a4f441d376ddc685f5d573a4a3c1684)
and the unchanged upstream gitlink `045b444e…`. The input manifest SHA256 is
`1157da5aadafd5d8c8fb8882d8e5600b49f0a046b1548ffde0d2fddd242fb750`.
The manifest records all differences from the earlier installed build, including
seven preexisting local input differences and the four batch-copy source/test
paths. This joins the actual artifact inputs to public source without changing
historical build claims.

The Linux x86_64 release was built locally with Rust 1.90.0, locked offline
dependencies, the pinned Amazon Linux 2023 image and no container network. Build
and ABI smoke passed, and every frozen/current input remained unchanged before
and after. The **13,309,056-byte** binary SHA256 is
`8ebeef106feee63a3f231584b4eff2d7df7ce2d164694e8cddfe8fc46ce89274`.
It requires at most GLIBC 2.34 and returns the expected usage exit 2 without a
configuration. Verification SHA256 is
`798d349d420f9c2c4517309b0aae2f1f66b9915833259fbff0095623353a0391`.

The first final evidence-checker invocation failed because its file-stat
comparison included read-induced access-time changes. The failed helper and
diagnosis remain retained. Excluding access time while preserving all content,
identity, ownership, size and modification/change-time checks fixed that local
checker. The build and smoke had already passed; runtime source was unchanged
and the binary was not rebuilt for this correction.

## Exact writer-only installation and cleanup

The predecessor is the [verified warm restart](PD-warm-restart-20261009.md),
receipt `e6d05884…09f95`. Installation command
`65ab4a59-165a-4bcf-8ba6-6de4587c5662` completed successfully from
**00:02:45 to 00:03:33 UTC**. Its full **68,349-byte** receipt was independently
retrieved and rehashed to
`d9c800a9b4f0251b01c8538ffa1e6cf7a3692e4874c7609b7d74ce9e270b1a2b`.

The writer changed from `0037eca8…7c8f49` to `8ebeef10…89274`, starting as PID
112032. Follower PID 110868 continued running `0037eca8…7c8f49` with its exact
prior invocation unchanged. The installer retained the old executable and
verified the stopped journal/archive inventory, configuration, unit policy,
protected files, four settled sessions and existing reservations. Database SHA
`49c3b138…60f16` and reservation SHA `29be8a5b…37706` remained unchanged.
The writer was observed inactive with an empty cgroup before replacement;
native exit metadata was unavailable, so a clean native exit is not claimed.

Transfer used one private encrypted, checksummed object version and an exact
version-only temporary read policy. Staging verified the candidate while all six
service identities and financial state stayed unchanged. The owned temporary
policy was removed, with the original policy list restored exactly. After
installation, the exact uploaded object version was deleted and a version-bound
HEAD returned 404. Local/installed binaries and all prior receipts remain retained.

## Measured catch-up interval

| Observation (UTC) | Durable blocks | Durable tail slot | Finalized RPC slot | Slot gap |
| --- | ---: | ---: | ---: | ---: |
| 00:04:58 | 442,757 | 508,966,443 | 508,991,835 | 25,392 |
| 00:07:54 | 446,456 | 508,970,179 | 508,992,575 | 22,396 |
| 00:14:30 | 456,157 | 508,979,923 | 508,994,233 | 14,310 |

Over **175.690 seconds**, the journal gained **3,699 blocks** and advanced
**3,736 slots**, approximately **21.05 archived blocks/second**. The gap reduced
by **2,996 slots**, approximately **17.05 slots/second** after accounting for the
advancing finalized tip. Both process identities remained stable; journal jobs
and transport records stayed zero, and cache anchors advanced. Cache inspection
in these observers reads metadata and does not repeat full checksum verification.

The separate later observation at **00:14:30 UTC** retains the same writer and
follower identities, zero jobs/transport records and no helper service or
financial action. The durable archive gained another **9,701 blocks** while its
gap reduced by **8,086 slots**. Available data-volume space was
**31,570,726,912 bytes**. This later point is retained alongside the original
two-observation interval.

These are descriptive measurements, not a controlled old/new
speedup or a completion-time guarantee. All saved health observations still
reported the startup snapshot (approximately 112, 288 and 684 seconds old) and
`ready: false`. Fresh finalized reconciliation and public gateway readiness
remain separate observations. No inference, AUTH, new reservation, deposit,
withdrawal or E01 action is established by this record.

At the retained CI observation, the earlier
[`ec640fa…` run](https://github.com/yukikm/solana-zkapi/actions/runs/37860649898)
had eight successful jobs with client/challenger still running. The exact
[`8423687…` successor run](https://github.com/yukikm/solana-zkapi/actions/runs/37862686638)
had three successful jobs with six running. These cuts are not full workflow
passes and do not authenticate the separately built local Linux binary.

The later [CI fixture diagnosis](PD-openrouter-retirement-fixture-ci-20261009.md)
records the original workflow's completed integration-test failure and its
separate local correction. It preserves the earlier in-progress cuts above and
does not change the installed artifact or these deployment observations.
