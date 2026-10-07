# Hosted CI formatting and browser-startup follow-up

Date: 2026-10-08 JST (local checks completed 2026-10-07 UTC).

This local candidate addresses two observed failures from implementation CI
[37689991621](https://github.com/yukikm/solana-zkapi/actions/runs/37689991621)
at `340b043760919782b563b1f0598f8af75083a2b9`. The original failed logs remain
retained with hashes in the [machine-readable checkpoint](PD-hosted-ci-format-browser-followup.json).
The separate [historical inventory correction](PD-historical-evidence-verification.md)
does not replace these failures or establish comprehensive CI success.

## Challenger formatting

The hosted client-challenger job stopped at its first `cargo fmt --check`.
Rust 1.90.0 formatting was applied to five challenger journal files after
preserving their exact before-images. A strict token comparison found only
whitespace changes and 32 formatter-added trailing commas before closing
delimiters. All literal and comment bytes are preserved. No runtime behavior,
archive format, source cursor, financial policy or test assertion was changed.

The following local checks passed:

```sh
cargo +1.90.0 fmt --manifest-path services/challenger/Cargo.toml -- --check
cargo +1.90.0 clippy --locked --offline --manifest-path services/challenger/Cargo.toml --all-targets -- -D warnings
```

Clippy completed in 8.24 seconds without warnings. A full runtime suite was not
rerun for these formatting-only changes. The frozen 187-input archive-indexer
source snapshot and its `7b2a4195…` Linux binary remain unchanged historical
artifacts; the formatted source has distinct hashes. This candidate did not
replace either installed server binary.

## Real-browser test startup

The hosted transport job failed while waiting for the journal test's Chromium
debugger port. The test now uses a monotonic 20-second startup deadline in place
of 150 fixed 30-millisecond polls; its enclosing test deadline increases from
25 to 45 seconds. Browser launch flags, one-launch behavior, production code,
custody assertions and crash-recovery checks remain unchanged.

The focused local journal-browser suite passed six tests with zero skips using
Chrome `154.0.8037.98`. The real-browser case took 1.247 seconds; the full command
took 3.217 seconds. This confirms the edited fixture still exercises the real
browser locally, without claiming that hosted startup has already passed.

## Scope

The candidate contains five Rust formatting changes, one browser test deadline
change and these two evidence files. Initial formatting failure and hosted
browser failure are retained. No release artifact, historical result, running
service, provider request, custody journal, funding or admission state was
changed. Hosted CI of this candidate, full I10, public funded acceptance and
release gates remain separate observations.
