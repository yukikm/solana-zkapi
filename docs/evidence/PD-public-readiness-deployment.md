# Public readiness deployment and admission resume

At **2026-10-08 15:16:43 UTC**, the deployed readiness path passed its guarded
completion and admission resumed. `/zkapi/v1/readiness` now reports control,
indexer and signer capabilities through the public HTTPS gateway. The exact
[receipt index](PD-public-readiness-deployment.json) preserves the earlier failed
observation and the separate successful completion; this is a dated sample,
not a continuous-availability guarantee.

| Installed payload | SHA-256 |
|---|---|
| Linux control binary, 14,013,552 bytes | `505b7e650ca2e258e5e282f24f6534fa20d9864a68c40e0046fc51a8920c36a7` |
| Gateway host source | `e070011e3cb5b569307de049403e73151ef9c047e91777753452a061d1c188ff` |
| Public gateway source | `aa5867462b90e83239841aa114ad4354a48ddc65640509dde17718fd765ab3e3` |
| Readiness projection source | `db5a207e54828184276dca680eaa838ef3a9996076a9670c1d180c485ba87634` |

These are the separately reviewed [readiness candidate](PD-public-readiness-candidate.md)
payloads. Exact-version private staging verified the binary before installation;
the temporary object permission was removed without deleting another policy.

The first apply installed all four payloads and started control and gateway,
but failed its final local gateway readiness check at **15:05:59 UTC**. Direct
control had returned HTTP200; the later gateway check returned HTTP503 after
21 seconds with `indexer: unavailable`. Admission remained suspended. The
underlying cause is **unproven**; the failure is not relabeled successful.
Control's stop recorded native exit zero; gateway exit metadata was unavailable.

A separate public GET returned HTTP200 at **15:09:43 UTC**. At **15:12:55 UTC**,
read-only completion verified the installed bytes, the same six process
identities, current direct/local/public readiness and unchanged financial state.
It made no source, configuration or service change. The explicit subsequent
resume restarted only gateway and changed only `allowNewAdmissions`. It verified
enabled admission/recovery and public readiness before saving the successful
receipt.

Across installation and resume, PostgreSQL, signer, challenger and archive
indexer processes remained unchanged. Control started once; gateway started once
for installation and once for resume. The complete database and reservation
hashes remained identical to the [closed native cut](PD-native-public-N04.md):
four full-cap reservations, four settled sessions, 20 micro-USDC of signed
charges and all 25 checkpoint rows. No AUTH, inference, wallet action or ledger
reset was added.

Readiness responses expire after five seconds. An enabled provider entry reports
configured capability and tariff availability; **provider credit and operator
admission are not checked by this endpoint**. Admission is reported separately
by relay configuration. The [provider-cost discrepancy](PD-openrouter-management-usage-limit.md)
remains unresolved. Funded browser cases, emergency escape/finalize and the
planned 80 GiB expansion are outside this completed checkpoint. No complete
fault matrix, full I10/G1–G4 or production availability claim follows.
