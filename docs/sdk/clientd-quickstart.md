# Use an existing AI application with Solana zkAPI

Run clientd on the same computer as your application. Set the application's
OpenAI-compatible base URL to `http://127.0.0.1:8787/v1` and use the generated
**local inference token** as its API key. The browser demo is not involved.
The application does not receive a provider management key or the wallet seed.
[OpenClaw has a tested configuration](../integrations/openclaw.md). The
[application integration table](../integrations/README.md) also links Claude
Code and Codex configuration guides and their current compatibility blockers.
Those two guides are not a funded-use acceptance claim.

A deployment operator must first supply the reviewed deployment inputs below.
There is no default public production operator or mainnet bundle in this
repository. Devnet token funding and SOL transaction fees are separate from real
provider charges. SDK settlement and withdrawal remain necessary.

## Install the current-platform package

Download and verify the prebuilt macOS ARM64 archive from the
[Kit preview release](../releases/kit-preview.md), then extract it into a
new directory. Obtain the archive and installed `release.json` hashes from the
authenticated release manifest. The following build command is for maintainers.

A maintainer builds a new output without modifying an existing installation:

```sh
python3 scripts/build_clientd_distribution.py --output /absolute/new-install
```

The package contains Node, clientd, native prover/verifier, the compiled SDK
installed from its tarball, npm dependencies, a dependency lock and upstream
license. The builder preserves the repository lock's transitive versions and
integrities, rejects dependency drift, and installs with `npm ci`. No checkout,
workspace TypeScript source, npm installation or demo UI is needed to run the
result. The private secret prompt helper optionally uses Python 3 on your host.
Build prerequisites remain the versions documented in the
[clientd README](../../apps/clientd/README.md).

Transfer the installation to the same OS/architecture and obtain the SHA-256 of
`release.json` through an independent trusted channel. A digest downloaded from
the same untrusted archive does not establish trust. Keep the installation
immutable; startup verifies every file and rejects unlisted files and symlinks.
Local packages are not production signed or notarized. Other OS packages are not
verified by a successful package on one platform.

The currently verified macOS ARM64 package requires macOS 13.5 or later (the
bundled Node executable's minimum OS version). Linux, Windows and Intel macOS
packages need separate builds and verification.

## Create a private profile

Obtain from the deployment maintainer:

- A reviewed `runtime.json` and its independently reviewed SHA-256, including
  the manifest trust policy, artifact paths, model/API/tariff allowlist, explicit
  direct/proxy mode, finalized RPC and indexer URLs. Every manifest, artifact,
  additional artifact and tariff file path must be absolute. The full format is
  in the [native runtime documentation](../../apps/clientd/README.md#distribution-and-configuration).
- A reviewed `network.json` with explicit direct/Tor mode and allowlisted
  control, provider, verifier, indexer and RPC origins/routes. Public network
  routes use HTTPS with the platform's trusted certificate roots. Private operator CAs require an explicitly reviewed `extra_ca` path and
  SHA-256 in the network configuration. Hostname verification remains enabled;
  copying an acceptance fixture profile is insufficient.

Use absolute paths and replace the two digest placeholders with the reviewed
values. The profile directory must be new; its parent must exist.

```sh
/absolute/new-install/bin/clientd setup \
  --profile /absolute/private/zkapi-profile \
  --distribution /absolute/new-install/release.json \
  --sha256 REVIEWED_RELEASE_SHA256 \
  --runtime-config /absolute/reviewed/runtime.json \
  --runtime-sha256 REVIEWED_RUNTIME_SHA256 \
  --network-config /absolute/reviewed/network.json
```

Setup creates a mode-0700 profile, separate random inference/management token
files, a journal directory and a local runtime configuration. It binds native
executable pins to the reviewed installation. It preserves the supplied manifest
policy and deployment artifact pins. Setup does not contact services, verify
live chain state, initialize custody, deposit, authorize or infer. `run` performs
the existing full trust/artifact/finalized-chain checks. Repeated setup refuses
to overwrite a profile; a failed setup retains any partial directory for review.

## Start and fund

Keep your existing Solana keypair JSON private (mode 0600). This helper prompts
on the terminal and sends secrets directly through a pipe. It never stores the
passphrase or copies the wallet key into the profile.

```sh
python3 /absolute/new-install/scripts/clientd_secrets.py \
  --initialize --wallet /absolute/private/wallet.json | \
  /absolute/new-install/bin/clientd run /absolute/private/zkapi-profile
```

Use `--initialize` only for the first successful custody initialization. On every
later start omit it, use the same passphrase, and preserve the profile/journal.
If startup created `custody.json` before failing later validation, omit
`--initialize` for the next attempt too. Missing/corrupt custody is never reset.
A password manager can supply the same bounded JSON through stdin instead; see
the native README. Do not put the wallet seed or custody passphrase into command
arguments, environment variables, logs or shell history. Application guides may
use a child-process environment variable for the separate local inference token;
never substitute the wallet secret, custody passphrase or management token.

In another terminal, `clientd request PROFILE models` lists allowed models and
`clientd request PROFILE status` reads redacted financial/recovery state.
Management commands use their private token automatically. For a self-funded
two-USDC deposit, save this public command JSON as `/absolute/deposit.json`,
substituting your wallet's public key for each role:

```json
{
  "action": "deposit",
  "amount": "2000000",
  "roles": {
    "payer": "WALLET_PUBLIC_KEY",
    "feePayer": "WALLET_PUBLIC_KEY",
    "uploader": "WALLET_PUBLIC_KEY",
    "rentPayer": "WALLET_PUBLIC_KEY",
    "tokenOwner": "WALLET_PUBLIC_KEY"
  }
}
```

```sh
/absolute/new-install/bin/clientd request /absolute/private/zkapi-profile wallet < /absolute/deposit.json
```

Every amount is an integer string in micro-USDC: `2000000` means two USDC.
Fund at least the deployment's authorization cap plus enough balance for the
planned charges. For example, a one-USDC cap and a deposit of exactly one USDC
cannot authorize a second request after any nonzero charge. Two USDC provides
headroom for the example cap; it is not a universal funding recommendation.
Deposit prepares the shared SDK operation. Send `{"action":"advance"}` with the
same `request ... wallet` command to advance one durable transaction step.
Inspect status after each step; proceed only once finalized wallet status is
`active`. An unknown send remains the same saved operation. Do not repeat a
new deposit, reset the profile or build a replacement transaction after a timeout.
Use `prove` only when the saved operation requires proof resumption; recovery
commands are documented in the [recovery guide](recovery.md).

## Connect, settle and withdraw

Give the application access to `PROFILE/inference-token` only. It is a local
spending credential. Use the exact advertised model ID and keep automatic
inference retries and model fallbacks disabled. A new request without a stable
operation UUID can become a separate charge, even if its prompt matches a
previous interrupted request. Client libraries that support it should use one
UUID `Idempotency-Key` for each intentional request and set their own retry count
to zero. Explicit recovery never replays inference.

`clientd request PROFILE close` closes the current API session through the
existing SDK. To withdraw, use a wallet command containing `action: "withdraw"`,
`mode: "mutual_close"`, `destination_owner: "WALLET_PUBLIC_KEY"` and the same
role object. Advance the saved withdrawal and confirm finalized `wallet_status:
"closed"`. `close` alone does not withdraw the deposited note.

If status reports `recovery_required`, stop the application's work and inspect
unresolved operation IDs. Use `clientd request PROFILE recover` or the explicit
wallet/reconciliation action from the recovery guide. Restart keeps the same
journal and attempts settlement; it does not resend inference. Keep encrypted
journal/custody backups plus an independently trusted journal head. The journal
retains exact request bodies, including supplied conversation history.
