# Public Devnet follow-up: local completion and deployment boundary

Recorded 2026-10-07 JST, on the uncommitted working tree based on
`eb9a5d1e384cee97a545e7482c0f3c223da0b2ac`. The independent `zkchat` application
has received the reviewed integration changes. Public deployment and funded
acceptance are still incomplete. This record supplements, without replacing,
the [earlier candidate checkpoint](PD-public-devnet-readiness.md).

## Completed work

- Corrected the four-file redistribution investigation using the original
  author's pinned MIT OR Apache-2.0 README declaration. The Apache-2.0 branch,
  exact upstream blobs and required notices are recorded in the
  [license follow-up](PD-02-redistribution-followup.md).
- Packaged a complete local schema-2 bundle: 26 files including its descriptor,
  ten authenticated notice files, 26,768,546 bytes total. The original setup,
  payloads and historical bundle remain unchanged. This bundle retains its old
  local deployment identities; it is not a fabricated public default.
  See [bundle and notice verification](PD-complete-bundle-notices.md).
- Generated six fresh Groth16 proofs through an independently installed SDK:
  tree insertion, request and escape withdrawal, each using native and bundle
  WASM provers. Independent Rust verification passed against the supplied keys;
  18 zero-proof, changed-input and wrong-key-digest rejection checks passed.
  [Proof evidence](PD-complete-bundle-proofs.md) separates these actual proofs
  from the earlier `snapshot_path` command check, which did not generate a proof.
- Added offline initial staging and public-origin authoring with strict setup,
  deployment, build, notice and authority joins. It declares `chainCompatible:
  false` until actual chain verification. It performs no network or funding.
- Added bounded native waiting for an already consumed response to reach signed
  settlement before a subsequent request. The default remains zero; generated
  native configuration selects 120 seconds. Ambiguous, canceled, interrupted or
  restarted requests retain explicit recovery. No inference retry is introduced.
- Applied 11 reviewed files to the independent app, preserving existing custody
  namespaces and historical evidence. Authenticated profiles, memory-only
  invitations, capability/readiness gates and recovery are integrated. The
  public configuration remains `null` until a real service is published.
  See [the app verification record](PD-zkchat-integration.md).
- Implemented an explicitly selected AWS budget authority for only the approved
  seven new caps. The original ledger is not moved or extended on AWS. A protected
  historical snapshot is provenance and a collision blacklist, not spendable
  capacity. See [detached budget evidence](PD-detached-budget-local.md).

## Verification and candidate artifacts

These are overlapping, separately scoped checks; their counts are not a single
combined acceptance total.

| Scope | Result |
|---|---|
| SDK suite | 377 passed, zero skips; 72 guarded inputs unchanged |
| Independently installed SDK | 75 tests plus one real native/WASM snapshot-path command; browser adapter 6, network 4, native installer 2; package inputs unchanged |
| Complete bundle | Six newly generated proofs and 18 negative checks; no RPC, AUTH or inference |
| Deployment authoring and notice packaging | 16 passed, four guarded source files unchanged |
| Gateway and relay/host suites | 40 passed, zero skips |
| Original, supplemental V1 and detached V2 budget fixtures | 35 passed, synthetic temporary state only |
| Independent app | 62 unit tests, SDK digest check, typecheck and production build passed in the actual destination; 12 Chromium tests passed on identical frozen staged source |
| Native distribution | 7,257 installed files verified; 543 source inputs unchanged; installed help passed |
| AWS configuration | 29-resource template accepted by AWS validation and cfn-lint; nginx syntax passed without starting a service |

Unreleased SDK `0.2.0-devnet.2` archive SHA-256:
`fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc`.
Current local macOS ARM64 native archive SHA-256:
`5361afa6db2acb05d1caa332855f624f2b1219dc2a4964d4690688e211865219`;
installed manifest SHA-256:
`7fb335301c392ec9071da49f4647e0065d934169bb9ebf9ce75493d2309a16ed`.
Complete local bundle descriptor SHA-256:
`4169846c4a8a02162ca4870ff069e86e94aa06064d67d17ce39e8f344bc1a423`.

The [machine-readable follow-up](PD-public-devnet-followup.json) retains report,
source and log hashes. Earlier two native builds are separate preserved
checkpoints; the current archive includes the final detached-budget source
provenance. No new public release or source-commit attestation has occurred.

## Decisions, preserved state and outstanding acceptance

The user selected AWS-generated HTTPS and approved **seven additional USDC** of
maximum provider exposure, covering seven one-USDC AUTH reservations. This
approval must initialize only one selected grant, never both V1 and V2. The
separate proposed AWS operating window of seven days and USD 100 total remains
pending. The [reviewable infrastructure and cost proposal](../../deploy/public-devnet/aws-cost-options.md)
requires that expense decision before resource creation. No actual grant has
been initialized and no new reservation, paid inference, funding, public-chain
write or cloud resource mutation occurred in this follow-up.

The original 17 reservations remain byte-identical at SHA-256
`513d46d07ac617d07e9620f3aac1d1809a8f5474cb22e442e46481f9055a2e29`:
9,154,216 reserved, 845,784 remaining. Existing services, private profiles,
immutable `.1` releases and unrelated `work/single-deposit-review/` are preserved.
Detached V2 is a single local writer, not distributed fencing or stale-backup
rollback detection. A valid older reservation file can restore apparent capacity
if an administrator replaces state; automatic rollback/clone promotion remains
prohibited and must not be described as supported recovery.

Remaining work is to provision the approved hosting, install persistent services
and the selected new authority, freeze a fresh finalized deployment/profile,
publish and anonymously verify all artifacts, then complete actual browser,
native/OpenClaw, provider settlement, interrupted recovery and withdrawal cases.
Operator recovery must also be exercised. Local fixtures do not close those
public backlog boxes, hosted CI, full I10 or G1–G4.

The first isolated app browser attempt failed because its matching Chromium
binary was absent. Normal Playwright installation resolved that prerequisite;
the original failure is retained. A fixture module-generation correction and
subsequent frozen-source run are recorded separately. The earlier user's Chrome
`ERR_BLOCKED_BY_CLIENT` observation was neither erased nor bypassed. The nginx
download first encountered Python's local certificate verification failure;
ordinary TLS-verified curl succeeded. No certificate checking was disabled.
