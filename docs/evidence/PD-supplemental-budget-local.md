# Supplemental budget local implementation

The user approved seven additional one-USDC provider reservations for B-01–B-03
and N-01–N-04 with no automatic replacement requests. The
[implemented adapter](../../deploy/public-devnet/supplemental-budget.md) is ready
for a reviewed authorization record after actual public pins and the selected
single authority are settled. **No actual supplemental grant was initialized,
no actual campaign state was accessed by these tests, and no supplemental
reservation, funding or provider request occurred.** Hosting approval is separate.

The helper shares the existing campaign flock, verifies exact original
plan/identity/state byte anchors, preserves original rows, and requires an
independently pinned owner-only approval file. It initializes one seven-cap
namespace explicitly, rejects duplicate/substituted/missing/partial grants,
checks UUID and exact AUTH hash across both ledgers, and retains every reserved
maximum. Acknowledgement follows file and directory fsync; an exact recovery
re-syncs state before permission to forward. The gateway has no grant-init path.

The `supplemental-v1` gateway selection joins the approved profile, manifest,
bundle, model, tariff, cap, 60-second session policy and reviewed release records
to authenticated public inputs. The fixed matrix requires declared streaming
and tools. Aggregate status never reveals row identities and uses only remaining
supplemental slots for new admission, leaving the original remainder untouched.
Incoming client binaries, private direct-provider bodies, output limits and
case/tool classification are acceptance evidence, not attested by an AUTH.

[Results and source hashes](PD-supplemental-budget-local.json): 21 Python tests
passed (nine original demo tests and twelve supplement tests); nine gateway
tests passed, including two new supplement integration tests. Cases include
concurrent reservation/exhaustion, unchanged legacy bytes and all historical
row kinds, cross-ledger collisions, suspended exact recovery, partial init,
changed identity/policy/authority, fsync failures before and after replacement,
local clone/lock replacement refusal and redacted failures. An independent
read-only review found no blocking issue. Initial fixture-path, parsed-object
prototype and loopback-permission failures are recorded separately in the JSON.

The path/device/inode checks are local authority guards. They do not establish
distributed fencing, automatic AWS migration, filesystem rollback resistance
or remote restore acceptance. Existing local services and private state remain
preserved. Legacy helpers are unchanged and do not consult the new supplement;
a changed original state stops the supplemental adapter and requires explicit
reconciliation. Public-host authority transfer must be reviewed before grant
creation. This local checkpoint is not public PD-08/PD-09 acceptance.
