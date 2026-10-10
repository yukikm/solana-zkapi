# Configure clientd runtime Tor or invitation access

These are optional alternatives to input generation in
[clientd installation step 2](clientd.md#2-check-the-deployment-and-generate-its-inputs).
Use them for a **new profile**. Keep funded profiles, their network configuration,
custody and journals unchanged; use their original recovery path.

Complete clientd steps 1–2 through preflight first, retaining `ZKAPI_ROOT`,
`ZKAPI_INSTALL`, `ZKAPI_RELEASE_SHA256`, `ZKAPI_PROFILE_URL` and
`ZKAPI_PROFILE_SHA256` in the same terminal. Choose one command below instead of
the ordinary `install-native` command. Each output directory must be new; its
parent must exist and use a canonical absolute path without symlinks.

**Downloads and preflight always use direct HTTPS.** `--runtime-network tor`
configures subsequent clientd traffic only. The helper does not offer downloads
or preflight through Tor. Local Tor tests do not establish live Tor/provider
acceptance or complete anonymity.

## Tor runtime

Install a Tor client using the [Tor Project's client guidance](https://support.torproject.org/little-t-tor/)
and start its local SOCKS5 listener, for example `127.0.0.1:9050`. Configure it
for local client use, not as a relay or public proxy. Keep it running while
clientd runs. A Tor Browser installation alone does not establish that this
listener exists at port 9050.

Generate the runtime inputs with that exact loopback endpoint:

```sh
ZKAPI_INPUTS="$ZKAPI_ROOT/public-devnet-sdk8-r6-tor"
"$ZKAPI_INSTALL/bin/node" "$ZKAPI_INSTALL/tools/public-devnet-consumer/cli.mjs" \
  install-native --profile-url "$ZKAPI_PROFILE_URL" \
  --profile-sha256 "$ZKAPI_PROFILE_SHA256" \
  --output "$ZKAPI_INPUTS" --runtime-network tor \
  --runtime-socks5 127.0.0.1:9050
```

Successful generation writes `network.json` with `mode: "tor"` and the selected
SOCKS5 address. The helper accepts a numeric `127.0.0.1` endpoint and port
1–65535. Use the actual listener port if different.

clientd routes control, provider, OA verifier (when applicable), indexer and RPC
through its configured relay. Tor mode passes destination hostnames to SOCKS5
for remote DNS and has **no direct fallback**. An unavailable listener blocks
runtime network access. A successful direct preflight does not prove that the
later Tor transport works. HTTPS certificate and route checks remain enabled.

Continue at [Create your private profile](#continue-with-clientd-setup).

## Invitation-gated deployment

The current public Devnet gateway does not require invitations. Omit this option
for that deployment. For another deployment, obtain its authenticated profile
URL/hash and a private invitation from its operator; use those profile values in
`ZKAPI_PROFILE_URL` and `ZKAPI_PROFILE_SHA256`. The installed SDK must be allowed
by that profile. An invitation does not override suspended admission or provide
provider credit.

The token file must contain only the operator's **43-character base64url token**
(optionally followed by one newline). It is neither a provider key nor a local
inference/management token. Keep the file outside the installation and generated
public-input directory, owned by you with mode `0600`, at a canonical absolute
path with no symlinks.

This terminal prompt writes a new private file without putting the token in
shell history or command arguments:

```sh
umask 077
ZKAPI_ADMISSION_TOKEN_FILE="$ZKAPI_ROOT/private-invitation-sdk8"
python3 - "$ZKAPI_ADMISSION_TOKEN_FILE" <<'PY'
import base64
import getpass
import re
import sys
import warnings

warnings.simplefilter('error', getpass.GetPassWarning)
token = getpass.getpass('Operator invitation: ')
if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
    raise SystemExit('Expected a 43-character base64url invitation.')
raw = base64.urlsafe_b64decode(token + '=')
if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode().rstrip('=') != token:
    raise SystemExit('Expected a canonical 32-byte base64url invitation.')
with open(sys.argv[1], 'x', encoding='ascii') as destination:
    destination.write(token + '\n')
PY
```

The command refuses an existing file. Preserve the token privately; do not put
it in public profiles, URLs, logs, issue reports or publicly shared backups.

For direct runtime access with an invitation:

```sh
ZKAPI_INPUTS="$ZKAPI_ROOT/operator-sdk8-invited"
"$ZKAPI_INSTALL/bin/node" "$ZKAPI_INSTALL/tools/public-devnet-consumer/cli.mjs" \
  install-native --profile-url "$ZKAPI_PROFILE_URL" \
  --profile-sha256 "$ZKAPI_PROFILE_SHA256" \
  --output "$ZKAPI_INPUTS" --runtime-network direct \
  --admission-token-file "$ZKAPI_ADMISSION_TOKEN_FILE"
```

For Tor runtime access and an invitation together, use this alternative instead:

```sh
ZKAPI_INPUTS="$ZKAPI_ROOT/operator-sdk8-invited-tor"
"$ZKAPI_INSTALL/bin/node" "$ZKAPI_INSTALL/tools/public-devnet-consumer/cli.mjs" \
  install-native --profile-url "$ZKAPI_PROFILE_URL" \
  --profile-sha256 "$ZKAPI_PROFILE_SHA256" \
  --output "$ZKAPI_INPUTS" --runtime-network tor \
  --runtime-socks5 127.0.0.1:9050 \
  --admission-token-file "$ZKAPI_ADMISSION_TOKEN_FILE"
```

The helper records the token's path and authenticated control origin in
`network.json`; it does not read, copy or print the token. Native setup/startup
validates the file. The relay adds `X-Zkapi-Admission` only to that origin's
exact `POST /zkapi/v1/sessions` request. Other control routes, providers, RPC,
indexers and downloads do not receive it. Preserve the token file at the same
path for the profile that references it.

## Continue with clientd setup

Keep `ZKAPI_INPUTS` set to the chosen new directory. Return to
[clientd step 3](clientd.md#3-create-your-private-profile): read that directory's
`installation.json` runtime digest, pass its `runtime.json` and `network.json`
to `clientd setup`, then start and inspect the daemon as documented.

Use a new private profile path. If `profile-sdk8` already exists, change the
step-3 `ZKAPI_PROFILE` assignment to another new path and retain that same value
through all later commands. Do not edit an existing funded profile to switch
transport or add an invitation. Input generation and setup perform no funding
or inference; actual transport, admission and provider readiness must still
succeed before new usage.
