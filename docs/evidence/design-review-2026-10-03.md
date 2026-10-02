# 実装Ready再レビュー — 2026-10-03

判定：指摘を設計契約へ反映後、I01から実装着手可能。実装済み・本番公開可能という判定ではない。暗号監査の代替でもない。

## 対象と指摘

implementation-ready、3仕様、OpenAPI/SQL/ベクトル、生成器、受入条件を照合した。オンチェーン、台帳、APIの観点を並行レビューした。

| ID | 優先度 | 問題 | 設計修正 / 実装受入 |
|---|---|---|---|
| R01 | P1 | buffer executeの署名にdigestがなく同PDA再作成時に別内容へ署名を流用できる | expected_digestを命令argsへ追加、T06で旧署名拒否 |
| R02 | P1 | 停止workerがwaiver/署名後に送信できる | dispatch attemptとegress fencing、fence不明なら署名保留、T11/T18 |
| R03 | P1 | tariff_hash、分母、項目合算とdirect USD丸めが未定義 | JCSと整数有理数計算を固定、端数vectors、T08/T10 |
| R04 | P1 | vault binding vectorが仕様よりraw32を1つ多く含む | 5 identities+decimalsへ修正、field数/順序を独立検査、I02 |
| R05 | P2 | direct作成202後にkey配信経路がない | 202/切断時close_requested、遅延成功をdrain、SDK recover close、T12 |
| R06 | P2 | 署名明細・multisig設定がstrict OpenAPIに存在しない | receipt API/key/schema/DBとmanifest authorities、T19/T20 |
| R07 | P2 | snapshot形式と閉鎖bufferのログ欠落復元が未定義 | snapshot wire、イベント全field、成功履歴replayを固定、T18 |
| R08 | P2 | session期限検査とidempotencyのendpoint bindingが曖昧 | ロック下の時刻/close検査、method/path/version/body HMAC、T09/T11 |
| R09 | P2 | u32 counter満杯表現・Schnorr scalar型が不整合 | counter u64、Note ID u32、ScalarをFrと分離、T01/T03 |
| R10 | P2 | PostgreSQL numericのNaNが金額CHECKを通る | amount_nanoで明示排除、DDL異常系試験 |

## 意図した差分

固定upstream commit/ライセンス方針、Poseidon、12/14 public inputs、historical-root challenge、nullifier式は変更していない。Solana transportのexpected_digest、満杯counter、イベント/snapshot、proxyの明細・fencingは移植先の追加契約。upstreamのu32 checked counterでは最後の加算がoverflowするが、移植先ではcounterだけをu64へ広げて最終leaf 2^32−1を利用後に2^32をTreeFull sentinelとする。Note IDと回路の32bit indexは変えない。900秒はegress停止確認を条件とする目標で、停止を証明できない場合に後継状態を発行しない。料金表の初期1 USD=1 USDC・手数料0とUSDC整数会計は維持。

固定upstreamの参照は[参照元記録](../ethereum-reference.json)。可変のtransaction条件は[Solana公式v1資料](https://solana.com/upgrades/larger-transaction-sizes)、scalar法は[ark-ed-on-bn254 0.5.0](https://docs.rs/ark-ed-on-bn254/0.5.0/src/ark_ed_on_bn254/fields/fr.rs.html)と照合した。provider cache usageの一次資料は[API仕様](../specs/api-proxy.md)にリンクした。モデル/価格の現行一覧は今回確定していない。

## 検証

修正前のpython3 scripts/check_design.pyはPASSだったが、上記矛盾を検出できなかった。修正後は以下を確認した。

| command / 環境 | 結果 | 検証の範囲 |
|---|---|---|
| python3 work/design/generate_contracts.py --check | PASS | OpenAPIとbinding/料金vectorsの生成物一致 |
| python3 scripts/check_design.py | PASS | 25 paths、78 schema参照、36機能、20受入シナリオ、4 H2F/8 micro丸めvectors、tariff hash/4有理数/3 direct USD vectors、文書links |
| python3 scripts/check_ledger_contract.py / PostgreSQL 18.6 (Homebrew) | PASS | 新規DDL適用、12件の異常系、正常なsettlement/receipt。専用Unix socketのみの使い捨てDBを起動・停止し、既存DBには接続せず |
| python3 scripts/check_openapi_contract.py / openapi-spec-validator 0.7.2、jsonschema 4.26.0 | PASS | OpenAPI 3.1、50 schemas、16件の正常/異常例 |
| git diff --check | PASS | 空白エラーなし |

OpenAPI validatorはTemporaryDirectory内のvenvへ `python -m pip install openapi-spec-validator==0.7.2` で導入し、実行後に削除した。グローバル環境やruntime依存を変更していない。SQL smoke testも実行後に専用DBを停止・削除する。DDL適用は確認したが、service migration、複数writerの競合、実egress遮断、provider/signer障害復旧は未検証。

SQLはnullifier排他、予算超過、activation日時、attempt一意性/owner不変、未終了attemptの精算禁止、丸め一致、署名/明細の不変性、NaN拒否を検査した。再レビューで期限判定をrow lock取得後のclock_timestamp由来時刻へ固定し、settlements INSERT→SIGN_PENDING CASの順序とdirect USD再計算情報を補った。

## 残る実測ゲート

G1〜G4はすべて未実施。I01の固定vendor/toolchain、I02の実proof/SVM/CU/tree fallback決定、I05/I10の競合・実障害復旧、I06/I07/I10の実provider、I11のsetup/audit/releaseは実装担当が証拠を取得する。今回のDDL構造試験もG2の代替ではない。I01〜I12はnot_startedのまま。本番購入・provider契約・mainnet配備は行わない。

## 検証対象artifact SHA-256

- `docs/contracts/openapi.json`: `bcf9edba8fdb482f976933083b87b46500004cc293699e6249355e8bb1d368d7`
- `docs/contracts/ledger.sql`: `d37de7668298c8bb8a719966fa5943dfcd118d0bf182d13e516a2d593feb0b77`
- `docs/contracts/binding-vectors.json`: `aa7439da78767d07755d332239ae022105adc4ba5643d868259f00650d996286`
- `scripts/check_design.py`: `9add383ee8b0e462571754df59eba34efd8897ae3efe7ba5e92031d931294644`
- `scripts/check_ledger_contract.py`: `0dddd0b639a4f28be656652135ccbd3b5f0a3049a9c860a84fcf5f411301a2dc`
- `scripts/ledger_contract_checks.sql`: `dbc7eaa143acb820b2668cf0244eb05dbcfa07c6ebed7a17c547e37fb50edc9c`
- `scripts/check_openapi_contract.py`: `a8cfea742569c2a20a847454c85972517aebb4babe6eab75df15aa1bab94fa4e`
- `work/design/generate_contracts.py`: `a97eadd1a596fb4f70d00744c474224159a3e8d203783b316c7d6e9230e2587d`
