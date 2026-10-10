# Repository guidance

## Start here

Read `README.md`, `CONTRIBUTING.md`, `docs/support.md` and the relevant
component README. Protocol work also starts with `docs/architecture.md`
and its referenced specifications. Public documentation and examples are English.

## Implementation invariants

- Reuse `ControlClient`, `WalletClient`, `ClientDaemon`, the encrypted journal
  and the shared accounting ledger; do not add another financial state machine.
- Use integer financial units, durable reservations, exact signed bytes,
  idempotent authorization and sign-once settlement.
- Never silently replay uncertain inference, resend uncertain transactions,
  replace custody bindings or switch direct requests to proxy.
- Keep existing funded profiles, journals, manifests, receipts and recovery
  material. An SDK update does not authorize a custody migration.
- Preserve the pinned upstream source and licenses. Intentional protocol,
  circuit, trust or deployment changes require explicit documentation.

## Verification and repository hygiene

- Use pinned toolchains and run checks appropriate to the change. Distinguish
  synthetic fixtures, real proof/SBF tests, public Devnet observations and CI.
- Store local reports, logs, receipts and operational handoffs in ignored
  `target/`. Never force-add them to Git. Keep reproducible
  tests, required fixtures, specifications, release notes and public guides tracked.
- Preserve operational history and custody locally. Public guides must not
  depend on ignored reports in a fresh clone. Keep procedures in
  `docs/getting-started/`; do not add progress logs or task backlogs.
- Do not commit credentials, private RPC URLs, wallet/note secrets, mutable
  financial state or raw private logs. Keep temporary review copies in `target/`.
- Existing published SDK/native releases are immutable. Check GitHub release
  assets and compare runtime inputs before deciding whether a new release is needed.

## Operational boundaries

Source maintenance does not authorize host changes, paid inference, wallet
transactions, new grants or capacity resets. The previously authorized seven
request slots were consumed; E01 and prior native lifecycles are closed and must
not be replayed. Preserve all original operational history and custody.
Production, mainnet, full provider/browser coverage and long-term availability
remain separate from the recorded Devnet preview scope. Read the current support
status before making release or availability claims.
