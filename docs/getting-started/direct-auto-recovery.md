# Automatic recovery for new direct sessions

This backend update prevents local preparation failures from becoming uncertain
provider sends. It also offers an explicitly configured operator-funded waiver
for new OpenRouter sessions whose issuance result remains unknown. It preserves
the shared ledger, signed receipts, sign-once settlement and original custody.

## Before-send failures

The dispatcher first validates its local inputs and writes its durable one-use
claim. The control service records send permission only after preparation
succeeds. A worker cannot contact the provider until it receives that permission
and rechecks the current database fence and original lease.

When preparation fails and the worker has actually exited, ordinary recovery
automatically closes and settles the unclaimed attempt with a signed
`not_dispatched` / `NOT_DISPATCHED` receipt and zero charge. Both ledger and
signer independently reject this receipt if any attempt was send-claimed or is
still live. No client message is resent. Keep the systemd storage preflight and
path-binding checks described in the [recovery upgrade guide](direct-recovery-upgrade.md).

## Unknown-result policy

The policy is disabled by default. To accept all unknown provider costs for new
sessions, set this field in the trusted control configuration:

```json
{
  "direct_unknown_auto_waiver": {
    "version": "1",
    "applies_to_sessions_created_at_or_after": 1800000000,
    "grace_seconds": 300,
    "accepts_all_unknown_provider_costs": true
  }
}
```

The timestamp above is illustrative. Use a future UTC Unix timestamp at rollout.
First startup registers the exact policy in the append-only ledger before
admission and rejects a cutoff already in the past. Preserve the configured
cutoff across restarts. A different policy cannot replace the existing
registration. Omitting the field disables automatic waivers without deleting
the registration or prior financial records.

Automatic waiver applies only to sessions created at or after that cutoff and
only to `direct_openrouter`. Normal recovery first attempts to locate and retire
the original key. If issuance remains unknown, the session must be closed,
never activated, have no saved key reference or usage, and have no receipt or
settlement. At least one attempt must have crossed the send-claim boundary, and
all attempts must have actual completion or fencing evidence. The original
provider lease must expire, followed by at least 300 seconds or the longer
configured provider grace. For a 60-second lease and 300-second grace, the time
condition is satisfied approximately six minutes after issuance began; provider
calls, recovery cadence and shutdown confirmation can delay completion.

The existing signed operator approval and receipt are created atomically with
an audit record of the exact policy. The user pays zero. Provider usage and
operator loss stay `null`, because this is acceptance of unknown costs rather
than proof of zero usage. The independent signer verifies the approval and
original evidence; the client verifies the signed successor before reusing its
balance. There is no public waiver endpoint and no automatic message resend,
key replacement, deposit or withdrawal.

While an eligible new session waits for the grace period, status reports that
operator intervention is not required. This is a read-only projection of the
same policy eligibility checks; status requests never create approvals or
change financial records. Older sessions, disabled policy and unconfirmed
sender termination retain the ordinary recovery indication.

An unfenced sender, database outage or invalid signing evidence still blocks
settlement. Neither elapsed time nor an old writer epoch proves process
termination. Repair the underlying condition through the existing supervisor
and recovery procedure. Older sessions remain eligible only for ordinary
recovery or the [explicit manual procedure](direct-unknown-operator-loss.md).

## Deployment and validation

Deploy matched control, dispatcher and signer binaries. Preserve the current
database, original claims directory, configuration bindings, keys and signer
journal. This change adds no schema version beyond the existing waiver migration
0005 and does not change receipt formats. Clients must already support direct
`waived_unknown` receipts; the local `.16` recovery preview does.

Before restarting the signer, audit historical direct `not_dispatched` receipts:
they must not have activated sessions, provider key references, send-claimed
attempts or unfinished senders. Keep admission closed during the maintenance cut
and until the configured cutoff has arrived. Verify original financial records
and custody, service readiness and exact binary hashes before reopening.

Use isolated PostgreSQL and local provider fixtures to verify preparation
failure, rejected send permission, one-shot dispatch, automatic policy cutoff,
lease/grace and stopped-attempt guards. Include real proof and independent
signer checks for both known nonissuance and unknown-cost waivers. Local tests
must not be described as evidence of live provider billing completeness or
production availability.

Set `ZKAPI_TEST_DATABASE_URL` to an isolated PostgreSQL instance, then run:

```sh
cargo test --locked --manifest-path services/control/Cargo.toml \
  --test dispatcher_preparation --test direct_not_dispatched \
  --test direct_auto_waiver -- --include-ignored
cargo test --locked --manifest-path services/control/Cargo.toml \
  --test provider_http_runtime direct_pre_send_failures -- --ignored
cargo test --locked --manifest-path services/control/Cargo.toml \
  --test provider_http_runtime direct_unknown_policy -- --ignored
```

These named HTTP fixtures use synthetic chain and provider responses with real
child processes, proofs and independent signing. Broader SBF integration tests
may additionally require a generated `target/i05/chain.json` fixture.
