# Shared archive indexer: host installation and startup observations

Recorded 2026-10-08 JST from completed host observations through
2026-10-07 22:26:37 UTC. The [local candidate](PD-shared-archive-indexer-candidate.md)
was installed and started on the new operator host. The
[machine-readable checkpoint](PD-shared-archive-indexer-host.json) records the
pins, retained failure hashes and redacted measurements. This checkpoint does
not establish public API readiness or funded acceptance.

## Exact installation

The installed follower binary is the 12,690,424-byte Linux candidate with
SHA-256 `7b2a41955e8a280a74235611388225a1b459b8bea73dfc2a4cd0b5ca955afce8`.
Its 187-input source manifest is
`b624cf278f184e3a5892de82ab36eacdd55fa3ead80a7d3759106ec8dd3ae90a`, joined
to source commit `046d7a17c39baa9492058504a056f61da7ad9c80`.
Later formatting and fixture follow-ups are separate source snapshots; they
did not rebuild this installed binary.

The encrypted transfer completed with the expected binary hash, and the
temporary transfer permission was removed. Installation then created a
distinct follower executable, configuration and snapshot directory. The unit
SHA-256 is `00fc4d30a980c67b897cf0c0206327a98d3ccfeca5cd6757ad90706c43cafd70`;
the private configuration is identified only by SHA-256
`e8995dc1518d46d1f1dbebaf1b8f618fa6d48bc037aa520593dda3821372cbfe`.

Original start slot `508520236` was preserved. All nine existing indexer
snapshot files remained unchanged and were copied with matching bytes into
the new output directory. The original indexer executable/configuration and
existing challenger writer remained in place. Installation performed a
unit reload without starting services and did not modify the source archive.
The existing writer continued appending its ordinary committed history.

## Permission probe and first start

An initial permission-probe preparation failed with a `TypeError` while
selecting a committed chunk, before the probe mutation stage. That failure
is retained. The corrected probe passed: the archive head, retained legacy
file, owner-lock file and one committed chunk were readable; attempted
write opens on the head, legacy and lock failed with `EROFS`. A separate
disposable snapshot output was writable. Eleven private source/process paths
were inaccessible, and the harmless `kill(self, 0)` and `pidfd_open(self)`
permission probes failed with `EPERM`; no signal was sent.
The probe made no RPC/DB calls and read no secret bytes.

The first `systemctl start` on 22:14:28 UTC returned exit zero, but its immediate
process postcheck failed an executable-identity assertion. No successful
wrapper result was fabricated and no second start or restart was issued.
A read-only check at 22:15:55 found the same process running the exact expected
binary. A continuation at 22:17:55 passed the complete postchecks on that same
process. These later observations are consistent with a short startup timing
race; they do not prove the exact cause of the initial assertion failure.

The actual follower had zero capabilities, `NoNewPrivileges`, active seccomp,
a private mount namespace, read-only archive/config binds and a distinct
writable snapshot bind. Private source paths and `/proc` were hidden. The
follower's own wrapper configuration, including its selected RPC URL, remains
readable by design. The denial checks concern signing/management material,
other private service configurations and process paths, rather than that
required RPC configuration. The reader uses the same Unix UID as the writer so it can read existing owner-only
archive files; this is an explicitly constrained preview arrangement, not
separation into independent OS security principals. It shares the host network
namespace for read-only RPC reconciliation. No protection against a privileged
kernel/filesystem attacker or unrestricted same-UID execution is claimed.

## Bounded startup observations

The following are samples from the same follower process. CPU seconds and
storage read bytes are cumulative kernel counters, not rates. RSS is sampled;
HWM is the process-reported high-water value at that observation. Decimal GB
is used for storage counters and available data-volume space.

| Observation UTC | RSS / HWM MiB | CPU seconds | Read GB | Data free GB | Local root / snapshot |
| --- | ---: | ---: | ---: | ---: | --- |
| 22:19:14 | 23.26 / 26.51 | 272.83 | 6.077 | 10.830 | unavailable |
| 22:22:31–22:23:11 | 45.74 / 45.74 | 459.74 | 7.648 | 10.631 | 503 / 503 |
| 22:25:58–22:26:37 | 48.27 / 50.12 | 659.26 | 10.149 | 10.428 | 503 / 503 |

Follower storage-write counters were zero at all three samples. The writer's
committed archive advanced from 60,922 blocks at slot `508581666` to 65,337
blocks at slot `508586143`. These are writer archive positions, not a measured
follower replay cursor. At the final sample the writer reported 4,469 seconds
of finalized lag, zero pending jobs and zero unknown signatures; its readiness
was still false. Available host memory was 3,377,434,624 bytes. The bounded
postcheck log window contained no paused-cursor record, which does not by
itself establish replay completion or absence of all errors.

The HTTP listener became observable, but no coherent published account cut
was established by these observations. Cold archive validation precedes the
graceful signal handler; no cold-stop or restart-recovery claim follows.
Control remained inactive and new admission remained disabled throughout
this checkpoint. No H02 operation, funding, AUTH, inference or provider
acceptance was performed by these installation and observation steps. Future
readiness, capacity, maintenance, service-restoration and funded acceptance
results require separate evidence; no sustained monthly capacity is inferred.
