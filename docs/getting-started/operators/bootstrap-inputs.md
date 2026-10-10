# Inputs for the public OpenRouter bootstrap

Use this with [direct OpenRouter setup](direct-openrouter.md). The helper
[`bootstrap_public_devnet_operator.py`](../../../scripts/bootstrap_public_devnet_operator.py)
initializes only a **new** operator on an empty `/srv/zka` mount. It supports
direct OpenRouter and a generated CloudFront origin. Existing financial state
uses [maintenance](same-state-restart.md), never bootstrap.

## Assemble the private directory

The input directory is owner-only, contains no symlinks and has this layout:

```text
operator-inputs/
  operator.json
  inventory.json
  openrouter-management.credential
  challenger-fee-key.json
  roles/
    quote.seed
    receipt.seed
    state.seed
    clearance.seed
  public/
    profile.json
    assets/
      bundle.json
      manifest.json
      ... every file referenced by bundle.json, including notices
  deployment/
    deployment.json
    build-manifest.json
    vault-idl.json
    zkapi_vault.so
    public-profile.json
```

Sources and required checks:

| Input | Source |
|---|---|
| `public/profile.json` | `consumer-profile.json` from the reviewed canonical deployment preparation |
| `public/assets/` | The complete prepared `assets/` directory; preserve exact filenames and bytes |
| Deployment record, build manifest, IDL and ELF | Matching files from the reviewed finalized deployment |
| `deployment/public-profile.json` | Original experimental setup profile; distinct from the consumer profile |
| `roles/*.seed` | The original setup's `private/{quote,receipt,state,clearance}.seed`, each exactly 32 raw bytes |
| `openrouter-management.credential` | Reviewed raw OpenRouter management credential without a newline |
| `challenger-fee-key.json` | Original Solana byte-array keypair for the named challenger payer |

The [deployment guide](deployment.md#pin-and-bootstrap-a-canonical-public-deployment)
defines staging and publication. Keep all role seeds and the challenger key
private. Verify the finalized Pool/build and initialization slot independently;
an offline prepared profile alone is not that observation. Source and public
profiles must bind the same setup, roles, program, mint, tariff and Pool.

Write `operator.json` with the actual values below. These deliberately invalid
placeholders show the full helper input contract:

```json
{
  "schema": 1,
  "new_operator": true,
  "public_origin": "https://YOUR_DISTRIBUTION.cloudfront.net",
  "manifest_sha256": "AUTHENTICATED_CANONICAL_MANIFEST_HASH",
  "profile_sha256": "SHA256_OF_PUBLIC_PROFILE_JSON_EXACT_BYTES",
  "start_slot": 1,
  "primary_rpc": "https://YOUR_PRIMARY_DEVNET_RPC",
  "secondary_rpc": "https://YOUR_INDEPENDENT_SECONDARY_DEVNET_RPC",
  "challenger_payer": "YOUR_CHALLENGER_PUBLIC_KEY",
  "binary_sha256": {
    "controld": "SHA256_OF_INSTALLED_CONTROLD",
    "signerd": "SHA256_OF_INSTALLED_SIGNERD",
    "dispatcherd": "SHA256_OF_INSTALLED_DISPATCHERD",
    "indexerd": "SHA256_OF_INSTALLED_INDEXERD",
    "challengerd": "SHA256_OF_INSTALLED_CHALLENGERD"
  },
  "tariffs": []
}
```

Replace `start_slot` with the positive finalized initialization slot (or a
reviewed earlier replay slot), and `tariffs` with the complete objects from
[provider preparation](../api-provider.md). Their hashes must appear in the signed
manifest. `manifest_sha256` is the manifest's authenticated canonical
`manifest_hash`; it is not the SHA-256 of pretty-printed JSON. By contrast,
`profile_sha256` and executable pins authenticate the exact file bytes.
The manifest must declare Devnet and cap `"1000000"`.

The helper configures OpenRouter retirement grace to five seconds. A provider
preparation plan can select a different policy; review the installed
`runtime/dispatcher.json` against the intended policy before starting control.
This is a provider accounting assumption, not proof of invoice finality.

## Pin the completed inventory

On the trusted preparation machine, after independently reviewing all files,
create the inventory once. This script prints only its digest:

```sh
python3 - /private/operator-inputs <<'PY'
from pathlib import Path
import hashlib, json, os, sys
os.umask(0o077)
root = Path(sys.argv[1]).resolve()
assert root.is_dir()
assert not (root / 'inventory.json').exists()
paths = sorted(root.rglob('*'))
assert not any(path.is_symlink() for path in paths)
files = {
    path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in paths if path.is_file()
}
data = (json.dumps({'schema': 1, 'files': files}, indent=2) + '\n').encode()
with (root / 'inventory.json').open('xb') as stream:
    stream.write(data)
print(hashlib.sha256(data).hexdigest())
PY
```

Retain that digest through an independent authenticated channel and pass it as
`--inventory-sha256`. Hashing files after an unverified transfer does not
authenticate them. The helper requires the inventory to name every input file
except itself, and rejects extra/missing files and changed hashes.

## Generated files

After successful first initialization:

| Location | Purpose |
|---|---|
| `/srv/zka/operator-initialization.json`, `operator-initialized.json` | Durable initialization identity and completion record |
| `/srv/zka/postgres/` | PostgreSQL ledger and WAL |
| `/srv/zka/runtime/control.json`, `control.env` | Control pins and writer connection |
| `/srv/zka/runtime/dispatcher.json`, `openrouter-management.credential` | Provider adapter and credential; separate read-only DB login |
| `/srv/zka/runtime/signer.json`, `signer.env`, role seeds | Original signer configuration and read-only connection |
| `/srv/zka/signer/signer.journal` | Independent sign-once journal |
| `/srv/zka/dispatcher/` | Durable one-shot dispatch claims |
| `/srv/zka/indexer/config.json`, `snapshots/` | Indexer configuration and authenticated public snapshots |
| `/srv/zka/challenger/config.json`, `journal/`, `alerts/`, `reader.dsn` | Challenger configuration, durable work, health and read-only connection |
| `/srv/zka/public/`, `/srv/zka/deployment/` | Reviewed public profile/assets and deployment inputs |
| `/srv/zka/config/` | Gateway configuration installed separately |
| `/srv/zka/budget-seven/`, `/srv/zka/history/` | Reserved finite-authority paths; no grant is initialized by bootstrap |

Only PostgreSQL starts automatically. Continue with signer/indexer, then
control/challenger and gateway in the [setup guide](direct-openrouter.md).
The initializer does not issue a provider key, send a chain transaction or
open public admission. Keep its input inventory and all original state for
restoration; a failed/partial bootstrap is not permission to start over.
