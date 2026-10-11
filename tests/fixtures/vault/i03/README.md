# I03 Vault regression fixtures

These deterministic, test-only fixtures preserve the historical Vault state
transitions and rejection behavior checked by `scripts/check_i04_results.py`.
They use synthetic local scenarios and public test keys. They are not public
Devnet observations, custody material, or release evidence.

The JSON files are unchanged copies from commit
[`9fb2e2849413f0efbf1059ecfd24f761ac0bc707`](https://github.com/yukikm/solana-zkapi/tree/9fb2e2849413f0efbf1059ecfd24f761ac0bc707/docs/evidence),
where they were stored under `docs/evidence/` before local reports were removed
from the tracked tree. Fresh I04 runs compare their generated results with these
fixed baselines; do not replace the baselines with the current run's output.

| File | SHA-256 of original bytes |
|---|---|
| `I03-svm-traces.json` | `3651ab83ecdc6735bdf5d32d6c22231ca23de094779567f58bab6ad9ca144d4c` |
| `I03-svm-rejections.json` | `f980c6d45b668ec427b07a8b1dbeb3879c8a79e01ac0a3b8a0f648ef2cdd0104` |
