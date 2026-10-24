# Explicit operator loss for an unresolved direct issuance

An absent OpenRouter key does not prove that no key was issued, that the key was
revoked, or that usage was zero. When original issuance evidence is permanently
unavailable, an operator may explicitly accept **all unknown provider costs** and
waive the user's charge. This is an exceptional local administrative action, not
an automatic recovery policy. It never issues another key or replays inference.

For future sessions, an operator can separately enable the
[automatic recovery policy](direct-auto-recovery.md). That policy retains the
same signed waiver evidence and does not enroll historical sessions.

This extension requires migration `0005_direct_unknown_waiver.sql`, the matching
control and signer binaries, and a client receipt verifier that supports direct
`waived_unknown` receipts. Older clients fail closed on this receipt shape. Keep
the original signer keys and journal, configuration, pool, funded notes, SDK
journal, receipts, and authorization history. No program or custody migration is
part of this operation. Publish new immutable release artifacts rather than
replacing an existing release.

Migration version checks are strict: after applying migration 0005, an older
control or signer binary cannot restart against that database, even before a
waiver is applied. Stage and verify the matching binaries before migration; use a
forward repair on deployment failure. Do not delete migration history or alter
its checksums to make an old binary start.

The eligible session must be `direct_openrouter` / `ISSUANCE_UNKNOWN`, already
closed, never activated, with no provider key reference, usage observation,
receipt, or settlement. Its original issuance intent must have expired plus at
least 300 seconds (or the longer configured drain interval). At least one
original issuance attempt must exist, and every attempt must have real finished
or fenced evidence. A lease timeout or old writer epoch cannot establish that a
sender has stopped.

Review the original accepted authorization, checkpoint, dispatch ownership and
completion evidence, complete provider lookup history (including disabled and
expired keys), and any available provider records. Retain that review privately
and compute its SHA-256. The review must state that issuance and provider costs
remain unknown and that the operator accepts those costs; do not rewrite it as
non-issuance or observed zero usage. The signed approval binds its digest, exact
ledger evidence, original expiry, deployment, pool, manifest, and one receipt ID.

Use the original configuration and a private database environment. Run the local
commands as root on a real deployment; approval files must be root-owned regular
files with owner-only permissions. The synthetic local adapter alone permits a
non-root test owner. Do not put database credentials or tokens on the command
line, or print the environment. The output directory must already be private.

```sh
controld plan-direct-waiver /private/control.json REQUEST_UUID \
  --review-evidence-sha256 REVIEW_SHA256 \
  --output /private/direct-waiver-approval.json \
  --accept-operator-loss
```

Planning reads a consistent database snapshot and writes a new canonical,
receipt-key-signed approval file with mode `0600`; it does not acquire the ledger
writer or change financial state. Review this exact file and the printed approval
hash. Apply within 15 minutes. If the checkpoint changes, review and create a new
plan. An expired plan cannot be renewed by editing its timestamp or signature.

Stop the control writer through the deployment's existing supervisor procedure,
without replacing its database, keys, or signer journal. Then apply the reviewed
file with the same configuration:

```sh
controld apply-direct-waiver /private/control.json \
  /private/direct-waiver-approval.json --accept-operator-loss
```

Application acquires the existing sole-writer lock and rechecks eligibility,
signature, freshness, and exact evidence. In one transaction it appends the
immutable approval, signs the zero-charge receipt, and moves the session to
`RECONCILING`. The receipt explicitly retains unknown provider USD, observed cost,
and operator loss (`null`), with `reason=waived_unknown`,
`evidence_kind=UNKNOWN_OPERATOR_LOSS`, and the approval hash as its evidence digest.
`direct_stop_evidence` remains empty. The separate `direct_waiver_evidence` link
freezes the original checkpoint and attempts; the AUTH nullifier stays reserved.

Restart the matching signer and control services using the retained journal and
configuration. Normal settlement recovery verifies the approval independently,
binds it to the receipt and original authorization, and signs one unchanged
settlement target. Provider recovery is skipped for the waived session. Restore
admission only through the normal audited startup/recovery process. The client
then retrieves and verifies that receipt and settlement before its funded note
can advance. This administrative command does not withdraw funds or send a chat
message.

Reapplying the identical signed approval returns the existing result, including
after restart or settlement. A different approval for the same request fails.
There is no public waiver HTTP endpoint. CLI failures print only bounded
categories such as `approval_expired`, `evidence_changed`,
`dispatch_not_quiesced`, `approval_conflict`, or `writer_unavailable`; they do not
print raw authorization evidence or credentials. Preserve the failed plan and
review the specific condition rather than editing ledger rows.

Local regression commands, against an isolated disposable PostgreSQL instance:

```sh
cargo test --locked --manifest-path services/control/Cargo.toml \
  --test direct_waiver_runtime --test direct_waiver_signer -- --ignored
```

The runtime suite uses synthetic authorization bytes and real PostgreSQL. The
signer suite separately uses a real proof and retained sign-once journal. These
are local acceptance results, not evidence of provider revocation or production
availability.
