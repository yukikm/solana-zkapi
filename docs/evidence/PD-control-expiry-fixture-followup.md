# Control ledger expiry fixture follow-up

Date: 2026-10-08 JST.

Implementation CI [37692298429](https://github.com/yukikm/solana-zkapi/actions/runs/37692298429)
at `046d7a17c39baa9492058504a056f61da7ad9c80` failed the first setup
reservation in `admission_expiry_cursor_and_direct_dispatch_contract` with
`Conflict("quote_expired")`. The original log and test bytes are retained and
hashed in the [checkpoint](PD-control-expiry-fixture-followup.json). Control
test and ledger source were unchanged from the preceding `340b0437…` source.

The fixture used `floor(database_clock) + 1` as its quote deadline. This leaves
between zero and one second for quote storage and the initial reservation;
the deadline can pass during setup. The log establishes expiration at the
first reservation, but does not measure the particular scheduling delay.
The production ledger correctly checks fresh database time after its live
check. This failure occurred before the intended recovery assertion.

The test now allows five seconds for setup and waits, with a 15-second bound,
until the same database clock reaches the recorded immutable expiry. The
accepted transcript must still recover without repeating its live check,
while a different request must remain rejected. The adjacent dispatch case
uses the same setup margin and exact expiry wait. An explicit callback-entry
assertion proves that expiry rejection occurs after entering the final live
check; zero dispatch attempts and signed zero-finalization remain required.
No production guard, SQL constraint, immutable timestamp, retry policy or
test skip was changed.

All five ledger fixtures passed with zero failures and zero ignored tests on
Rust 1.90.0 and a new local PostgreSQL 18.6 (Homebrew) cluster. The test harness
reported 14.49 seconds; the complete isolated run took 17.674 seconds. The
cluster used a unique Unix socket, no TCP listener, and `fsync=on`; only this
new cluster was stopped, with exit code zero. Formatting also passed. Source
hashes remained unchanged throughout the run, and independent review found
no blocking issue.

This is local real-PostgreSQL fixture evidence. It is not a hosted PostgreSQL
16.15 rerun, a complete control/SBF regression, public funded acceptance, or
a release-gate result. No installed service, existing database, public
provider request, custody state, funding or reservation was changed.
