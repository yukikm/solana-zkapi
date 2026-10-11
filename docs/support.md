# Support

ZKAPI is a Devnet preview. The SDK/native `0.2.0-devnet.9`
[timeout release](releases/timeout-preview.md) builds on `.8`; general JSON API
work on later main-branch source is outside this release.

SDK distribution uses GitHub tarballs, not npm registry publication. Native
packages support Apple Silicon on macOS 13.5+ and are not Apple notarized.
The public profile supports direct OpenRouter Chat Completions. Listed models
and read-only readiness do not establish provider credit or successful inference.
Production, mainnet, full provider/browser coverage and long-term availability
remain unverified. No new funded lifecycle test accompanies this timeout release.

The server repair on 2026-10-11 restored the recorded read-only root/readiness
checks and all ten checks from the existing `.8` client. That observation is
separate from this client release and is not an uptime guarantee. Use fresh
preflight to check current service state.

Preserve existing funded runtimes, profiles, journals, receipts and recovery
material. Follow [upgrade guidance](releases/usability-preview.md#existing-installations)
and use the original runtime for unfinished operations. A release does not
authorize custody migration, inference replay or additional provider spending.
