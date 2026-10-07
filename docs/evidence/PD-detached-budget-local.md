# Detached seven-cap budget: local validation

Recorded 2026-10-07 JST. The user approved **seven additional USDC** of provider
exposure for B-01–B-03 and N-01–N-04. The separate proposed **USD 100 AWS hosting
expense approval is still pending**. No actual original snapshot was exported,
no grant was initialized, and no provider, funding, deployment or cloud mutation
was performed by this implementation or its tests.

The new `supplemental-detached-v2` selection uses one fresh AWS authority with
exactly seven full 1,000,000-micro-USDC reservations. It links to an independently
pinned historical snapshot of the original ledger and transfers none of the
old 845,784-micro-USDC remainder. Every historical request UUID or AUTH hash is
rejected, including exact old recovery. Existing local recovery remains at the
original authority; only exact reservations in the new grant can recover there.

The production snapshot reader requires a non-root runtime, root-owned protected
ancestors and a root-owned private file that the runtime cannot write. Runtime
commands accept no original plan path or writable original ledger. Gateway
startup invokes only status; its adapter can later reserve but cannot initialize
or export. The single grant marker/index, exact authorization/deployment pins,
local lock/inode checks and fsync-before-ack preserve consumed capacity.

Public status counts only the active seven-USDC grant and labels history as a
non-live snapshot with zero transferred capacity. Later original reservations
are not visible to AWS. This is not distributed fencing, remote clone detection
or stale-backup promotion support. One selected writer and a recorded unique
grant/digest remain required. The seven-USDC approval must never initialize both
the existing V1 local supplement and the new V2 authority.

Local checks passed:

- All 35 provider budget tests, including 14 new detached tests and unchanged
  original/V1 fixture scopes.
- Four gateway budget fixtures, covering V1 and V2 selection, suspension/exact
  recovery, active-only status, pin validation and historical receipt rejection.
- Strict standalone TypeScript checking of gateway source/tests.
- `git diff --check`.

The detached tests use temporary synthetic ledgers. They replace only the
root-owned snapshot file reader because they do not install privileged files;
the production reader separately rejects runtime-owned and symlinked inputs.
They test concurrent duplicates/exhaustion, corruption, original preservation,
history mutation, grant reuse/partial initialization and uncertain fsync. Actual
AWS file ownership/systemd confinement remains to be verified on the host.

An independent read-only review found no blocking defect in snapshot anchoring,
historical denial, marker/index identity or durability. It confirmed two limits:
the proposal is unapproved until final authorization validation, and the snapshot
does not establish live deduplication with later original reservations.

Exact source hashes and test commands are retained in the
[machine-readable checkpoint](PD-detached-budget-local.json). The
[deployment workflow](../../deploy/public-devnet/detached-budget.md) specifies
the one-time export, root-owned installation, existing approval record, new
authority initialization, gateway configuration and restore boundary. No public
TLS, actual provider/chain acceptance or full release-gate claim follows from
these local checks.
