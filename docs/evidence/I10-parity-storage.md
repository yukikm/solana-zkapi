# Browser custody persistence and test cleanup

New browser custody explicitly requests persistent origin storage and reports
the browser's decision. Existing custody can reopen without a permission
request. The real Chromium custody regression passes with bounded cleanup for
startup failures, signal exits and unresponsive browser processes.

## Browser custody behavior

`openBrowserStorage()` requests `navigator.storage.persist()` only after an
explicit initialization creates a new key. Concurrent initializers share the
existing Web Lock, so they make at most one request. Reopening an existing key,
including with `initialize: true`, only queries retention. Missing keys with
existing ciphertext remain an error and never trigger initialization or a
persistence request.

Both `openBrowserStorage()` and `createBrowserClient()` return `persistence`, an
opening-time observation with these values:

| Value | Meaning |
|---|---|
| `persistent` | The browser reported persistent origin storage |
| `best_effort` | The browser reported storage without persistence, including a denied request |
| `unknown` | Browser support or a successful observation was unavailable |

Permission failure does not reset custody or falsely report persistence. The
standalone application can display the returned status. In the actual isolated
headless Chrome run, persistence was denied and the SDK correctly returned
`best_effort`.

Persistent origin storage is not a backup. It does not protect against clearing
site data, profile/device loss, a compromised application origin or whole-device
rollback. Portable backup was not added: safe export and restoration require
separately designed custody and trusted journal checkpoints. The nonextractable
AES key, encrypted journal schema and existing live-demo custody were unchanged.

## Browser test reliability

The previous cleanup checked only `child.exitCode`. A process that already
exited through a signal retains `exitCode === null`, so cleanup could wait forever
for an exit event that had already happened. A raw Chromium launch reproduced
the hang: the outer 10-second timeout exited with code 124. After the fix, that
unsupported launcher reports its SUID sandbox/startup failure and exits normally
with test failure in 2.79 seconds instead of hanging.

Cleanup now checks both exit and signal state, bounds TERM/KILL waits, closes
inherited pipe handles, and uses one ordered hook for debugger sockets, browser,
HTTP connections and temporary profile removal. Debugger connections, commands
and local HTTP requests also have bounded waits.

A subsequent run caught a separate readiness race: Chrome had created an empty
`DevToolsActivePort` file, which became port zero and prematurely ended polling.
Readiness now requires a complete valid port line. A regression covers empty
and partial writes. None of the existing encryption, cross-tab CAS, Web Lock,
tab-crash recovery or missing-key assertions were removed.

## Validation

The final command passed **20 tests**, zero failures or skips, with Node
**24.19.0** and real **Chrome/151.0.7922.173**:

```sh
ZKAPI_TEST_CHROME=/workspace/work/chromium-review node --test --test-reporter=tap packages/sdk/test/journal-browser.test.ts packages/sdk/test/trust.test.ts
```

This includes three lifecycle/readiness tests, one real-browser custody test
and the existing trust tests. The browser test uses real IndexedDB, Web Locks
and Web Crypto in an isolated temporary profile. It additionally exercises
granted, denied, unavailable and failed persistence APIs through deterministic
browser API overrides; those overrides do not replace IndexedDB or encryption.
An actual browser persistence request is exercised separately from the overrides.

SDK and browser example TypeScript checks and `git diff --check` passed. The
managed environment's [test launcher](I10-parity-storage-components/chromium-cloud-launcher.sh)
uses writable XDG directories and `--no-sandbox`; these are test-launch settings,
not changes to application browser flags or a system Chromium installation.

[Command results and log hashes](I10-parity-storage-components/results.json)
preserve every distinct validation stage, including the initial startup hang,
expected unsupported-launcher failure and intermediate port-file race.
[Final TAP output](I10-parity-storage-components/final.tap) records the passing
run. Earlier passing stages overlap and should not be added to its test count.

No existing live browser profile, funded key, journal, deployment or provider
request was touched. These local results do not establish portable backup,
Phantom acceptance, public-chain behavior or production release readiness.
