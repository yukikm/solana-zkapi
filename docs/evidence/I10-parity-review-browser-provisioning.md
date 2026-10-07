# Standalone browser configuration and admission follow-up

Reviewed 2026-10-07 JST. The default standalone app intentionally had no installed
deployment, but there was no integrated way to use the freshly verified devnet
services from that app. A profile entry alone could not bridge independently
pinned logical origins to the local services or serve authenticated public assets.

## Changes

- `build.mjs` accepts an explicit public profile file, independently retained
  SHA256 and separate output directory. The default build remains empty.
  Configuration has a closed public schema; private host fields, credential URLs
  and unsupported routes are rejected before output changes. Hash and Ed25519
  manifest anchors remain independent of downloaded artifacts.
- The configured build embeds the reviewed profile and records its digest plus
  exact hashes for all five output assets in `profile-build.json`. It has no
  runtime URL/hash configuration mechanism. The separate host verifies this
  metadata, public artifact digests and manifest before serving.
- One app-owned fetch adapter routes bounded RPC, common snapshots, financial
  recovery paths and control operations to the current numeric-loopback origin.
  It also supplies web3's RPC fetch. It preserves the manifest's logical origins,
  request bytes and abort signals. Direct Chat Completions stays browser to
  OpenRouter; unknown origin/path/method/RPC requests fail without retry or proxy
  fallback. Cookies are omitted, redirects refused and requests time-bounded.
- A 4 KiB/five-second public budget read presents request capacity, per-session
  worst-case reservation and unreserved campaign budget separately from actual
  SDK-verified charges. It rechecks before new deposit preparation and each new
  request. A read-only host, exhausted capacity or unavailable hint disables
  those two new actions. Opening status, saved-operation recovery and withdrawal
  controls remain available. The host's durable reservation before AUTH remains
  the admission authority, including races after this hint was read.

The host and budget implementations were developed and tested separately in
`scripts/browser_chat_devnet_host.ts` and the existing campaign coordinator.
No provider inference is relayed through that host. Existing funded deployments,
manifest pins, journals and reservations are preserved.

## Verification

The [recorded local command matrix](I10-parity-review-browser-provisioning-components/results.json)
passed all five stages with Node 24.19.0:

| Check | Result |
| --- | --- |
| Build/profile/transport/admission and existing conversation/native-reader tests | 22 passed, zero failures/skips |
| Strict example TypeScript check | Passed |
| Default unconfigured app/worker build | Passed |
| Actual Chrome 154.0.8037.98 isolated UI scenario | 1 passed, zero failures/skips |
| `git diff --check` | Passed |

All 48 recorded source inputs were unchanged during the run.
The configured-build test uses a synthetic public profile and isolated temporary
output. It proves that an incorrect profile digest or private credential URL is
rejected without replacing an earlier build. Transport tests retain the exact
direct body and credential destination and reject unknown routes before network
access. The Chrome fixture checks exhausted/unavailable/read-only admission,
rechecks stale visible send/deposit actions, and verifies continued recovery and
withdrawal controls. It still has six synthetic inference calls: rejected budget
checks add none. Default startup still has zero wallet/network effects.

These are local source tests with synthetic SDK/wallet/provider ports. They do
not establish actual browser CORS, fresh-profile Phantom funding, repeated live
conversation or streaming acceptance. Root-task public bundle provisioning and
any actual browser observations must be recorded separately. The older actual
fixed-prompt Chrome/Phantom successes and fresh native OpenRouter plain/SSE
results retain their own scopes and are not relabeled as standalone browser
acceptance. Mainnet and independent code audit remain outside this devnet gate.
