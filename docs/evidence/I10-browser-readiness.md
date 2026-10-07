# Browser journal test readiness — 2026-10-07 JST

A fresh aggregate passed 312 SDK tests but failed the actual Chrome journal
test with `Execution context was destroyed.`. The old harness opened a target
directly at the fixture origin, then immediately evaluated an asynchronous
module import and journal initialization. That evaluation could overlap the
target's initial navigation.

The test now creates an `about:blank` target, enables Page control, explicitly
navigates to the fixture origin, and waits for the exact expected URL and
`document.readyState === 'complete'` before initializing the journal once.
Only the bounded read-only readiness probe tolerates the observed transient
execution-context error. Unrelated debugger errors fail immediately. Module
initialization and journal operations are never replayed or retried.

```sh
target/i08-toolchain/bin/node --test --test-reporter=tap \
  packages/sdk/test/journal-browser.test.ts
```

The [focused report](I10-browser-readiness-results.json) and
[log](I10-browser-readiness-tests.txt) record six passing tests, zero failures or
skips, in 2.763 seconds on Chrome 154.0.8037.98. Two new readiness checks cover
the transient navigation window and immediate failure on unrelated debugger
errors. The actual browser again verifies cross-tab CAS, encrypted restart,
Web Locks, tab crash recovery and browser key custody.

This is a test-harness-only change; the corrected SDK runtime tarball remains
SHA-256 `fc37358ce00fa7bcb5c43367c8f09b3908c617f9235e8646ae78003a21040c91`.
The initial failed aggregate remains preserved, and a later full aggregate must
be evaluated separately. These local fixtures establish no Phantom, devnet,
provider or production acceptance.
