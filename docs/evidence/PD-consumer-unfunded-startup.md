# Public consumer preflight and unfunded initialization

Recorded 2026-10-08 JST. The actual publicly downloaded macOS ARM64 client passed
read-only preflight, installed its authenticated inputs, and started the stock
native supervisor with new local custody. The public R2 chat app also passed
connection checks and explicitly created new browser storage. **Both remained
unfunded; no AUTH, inference or wallet transaction was submitted.**

The installed CLI verified the profile, assets, manifest, tariffs, genesis,
finalized Pool, control configuration, catalog, shared snapshot and chain clock
at slot **508551083**. `install-native` repeated those checks at **508551547**.
Both reported `paused: false` and `operatorAdmission: unverified`; these checks
do not establish operator admission or provider acceptance. The initial
`snapshot` failure remains preserved alongside these later successes.

The reviewed inputs have runtime SHA-256
`0049cd4cb066a27f5929530e1028537f7c3c26ffb79259f37c3dd8b4ed13426c`,
network SHA-256
`40ab56656a92e06f930df546434e3ba48d8b00d17ac089b5ccdb738a11387bc2`,
and notice-index SHA-256
`0d887f467d49bf4e70e7f498005e2abd3cb276480e2e63fefd4b2e81405d24f8`.
They join the [published client/profile pins](../sdk/public-devnet-preview.md).
Setup created a new private profile without custody or funding. Its subsequent
first startup passed secrets only through stdin and used a separate process
group. The stock listener became available; status reported `unfunded`, zero
balance/in-flight operations, no recovery requirement, no wallet operation,
zero key reuse and a null journal head. The model endpoint returned the expected
`openai/gpt-4o-mini` entry. No old profile or journal was reset.

In actual Chrome with the selected existing Phantom account, the
[published R2 application](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/chat-en-r2/index.html)
passed Verify connection and explicit Create storage. The retained screenshot
shows “Deployment and wallet connection verified.” and a zero balance. The
operator recorded no invitation entry, signature, deposit, AUTH or inference;
new funding remained unavailable without an invitation. This is a live UI
observation, not independent browser-journal or settlement verification.

[Machine-readable evidence](PD-consumer-unfunded-startup.json) includes the
redacted preflight/status results and exact hashes of the installation, startup,
model and screenshot records. Earlier R1/R2 publication evidence and failures
remain unchanged. R1's 12 E2E tests and R2's 66 unit tests/build retain their
original source scopes; this observation adds no E2E run.

This checkpoint does not complete clean-machine onboarding, funded browser or
native/provider lifecycles, interruption recovery, settlement, withdrawal, or
PD-07/08/09. Keep the same newly initialized custody, profile and journal for
the separately controlled acceptance steps.
