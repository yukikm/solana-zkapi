# Upgrade an existing installation

Use this procedure when an existing clientd or SDK application already has a
profile, journal or note. A new release is a separate installation; it does not
migrate custody. The intended result is to finish the original note, retain its
recovery material, and then create a new installation with the new release.

You need the original working runtime, its private profile/storage, wallet and
passphrase, plus the verified new release. Current downloads and hashes are in
[Public Devnet](public-devnet-preview.md). Release changes are described in the
[`.8` release notes](../releases/usability-preview.md).

## 1. Inspect the original installation

Stop new application requests and finish or cancel outstanding response bodies.
Keep the original clientd running. Use its own binary and actual profile path:

```sh
umask 077
ZKAPI_OLD_INSTALL='/absolute/path/to/original-installation'
ZKAPI_OLD_PROFILE='/absolute/path/to/original-profile'
ZKAPI_UPGRADE_CHECK='/absolute/path/to/new-private-upgrade-check'
mkdir "$ZKAPI_UPGRADE_CHECK"
"$ZKAPI_OLD_INSTALL/bin/clientd" request "$ZKAPI_OLD_PROFILE" status \
  > "$ZKAPI_UPGRADE_CHECK/original-status.json"
```

The output file contains private status information. Keep it owner-only. For a
browser application, reopen the same origin, wallet/account and storage name,
and inspect `await client.status()` through the original application. Never
clear site data or change the deployment profile to make an old note reopen.

## 2. Read the upgrade plan

Download and verify the new native archive using only the download/extraction
steps in [clientd installation](clientd.md#1-download-and-verify). Keep it in a
new directory. Do not run setup over the old profile. The new helper can inspect
the exported status without opening the old journal or contacting the network:

```sh
ZKAPI_NEW_INSTALL='/absolute/path/to/new-verified-installation'
"$ZKAPI_NEW_INSTALL/bin/node" \
  "$ZKAPI_NEW_INSTALL/tools/public-devnet-consumer/cli.mjs" \
  upgrade-plan --status-file "$ZKAPI_UPGRADE_CHECK/original-status.json"
```

A `.8` installation can also run `clientd request PROFILE upgrade-plan`.
SDK hosts use `await client.upgradePlan()` or
`planClientUpgrade(originalStatus)` from `@zkapi/solana-sdk/client-guidance`.
The plan is read-only guidance, not a chain attestation or migration action.

## 3. Complete the original lifecycle

Follow [recovery](recovery.md) for every listed pending response, wallet
operation, session or emergency escape. If the original profile is unfunded,
with no note or pending operation and upgrade-plan assessment
`ready_for_separate_installation`, there is
nothing to settle or withdraw. Otherwise, settle and withdraw with the original
installation. The [clientd withdrawal procedure](clientd.md#stop-restart-and-withdraw)
uses its original profile and deployment. A zero balance is insufficient if the
note is still active, and a withdrawn note can still have unresolved emergency
recovery.

In particular, an emergency escape finalized without a challenge can leave a
`closed` wallet with an `escaping` archive. The current CLI cannot clear that
archive and the upgrade plan remains `needs_attention`. Preserve the original
material and obtain operator/developer review; `reconcile-challenge` does not
resolve this closed-wallet case. Do not reset storage to bypass the result.

Missing fields in older status are `unknown`, not permission to replace custody.
If the original runtime or custody is unavailable, preserve the files and stop
at recovery; a new profile cannot recover another profile's funds.

Export fresh original status after completing those actions and rerun the plan.
Proceed only when no unresolved work or open note remains. Keep the original
installation, profile, journal, deployment inputs and independently retained
recovery checkpoints even after closure.

## 4. Start the new installation

Stop the original daemon after its lifecycle is complete so the loopback port
is available. Follow [clientd setup](clientd.md#2-check-the-deployment-and-generate-its-inputs)
using new input and profile directories, or [SDK setup](sdk.md) with an explicitly
new storage identity. Run fresh preflight and fund only after checking the new
configuration. Reconfigure [OpenClaw](openclaw.md) to use the new profile's
inference-token reference; old tokens do not transfer automatically.

For TypeScript applications upgrading from the first preview, also follow the
[Kit migration](sdk-migration.md). Keep application lockfiles and independently
verified release hashes with the corresponding installation.

Success means the original note is closed, or the original profile was unfunded
with no note, and no unresolved recovery remains. The new installation passes
read-only preflight, and its separate profile reports an
unfunded state before any new deposit. A successful upgrade-plan result does not
establish provider availability or authorize an inference request.
