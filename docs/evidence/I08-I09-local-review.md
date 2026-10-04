# I08/I09 local受入後レビュー

2026-10-04 JST。[local受入](I08-I09-local-acceptance.md)に記録された未コミットの追加実装を、開始契約・正本仕様・実装・runtime試験でレビューした。初期sliceのレビューは[I08-I09-review.md](I08-I09-review.md)に保存する。本書は追加実装に対する後続レビューである。

## 修正した問題

| 対象 | 問題と影響 | 修正と検証 |
|---|---|---|
| Walletの確定失敗 | USDC不足など非staleの確定拒否が`failed`で永久停止し、復旧APIがなかった | 明示`retryRejected`と管理APIを追加。同じ署名の確定拒否を再照合し、既存bufferをcloseしてから再prove。secret/N/clearance/宛先を保持し、入金ID/expiry・finalize deadlineを再確認。未知署名の置換は拒否 |
| HTTP切断 | header到着前と、応答を書き始める前の切断を見逃し、推論やstream finalizerが残留した | HTTP接続から既存SDKの推論fetchまでAbortSignalを伝達し、既に切れた応答bodyもcancel。送信不明journalを維持し、推論再送はしない |
| clientd shutdown | 認可準備中はinflight=0のため、終了処理が早く完了する競合があった | admission直列区間が完了してからinflightを待ち、精算/close保存まで進む |
| Goの強制終了 | GoだけがSIGKILLされるとNodeがjournal lockを保持し続け、再起動できなかった | 秘密引き渡しに使うprivate stdin pipeを親の生存確認にも使い、EOFでNode終了処理へ接続。インストール済Goの実Vault復旧試験をSIGKILLへ強化 |
| Challengerのログ欠落 | indexerが命令/buffer履歴から復元できても、challengerは生event logだけからPending世代を取得していた | 既存indexerの検証済transitionを共有。実SBF archiveの全eventを除去して同じPending世代を復元する回帰 |
| 古いbuffer不在 | 確定失敗より古いaccount cutをcleanup済みと誤認できた | wallet/SDK/challengerで失敗receipt以上のslotを要求。challengerは同slotのblockhashも一致させ、未知attempt・古いcut・別forkを拒否 |
| DB復旧の照合漏れ | pool設定/epoch、料金表、provider証拠、chain checkpoint/event/transactionが復旧witnessに含まれなかった | version 2 witnessに追加。各対象の欠落/変更を実DBで拒否し、旧v1は拒否。WAL failover比較も全16台帳tableへ拡張 |
| DB復旧のtimezone依存 | observerのtimezone変更だけで同じtimestampのrow hashが変わり、正しい復旧を拒否した | read-only transaction内のUTC固定。UTC→Asia/Tokyoで同じwitnessを検証する回帰 |
| DB復旧のpool指定 | `opsd verify-restore`が設定と異なるpoolのwitnessを受け入れた | CLIでpool一致を要求。別poolの設定による実process検証を拒否 |
| Provider受付再開 | メモリー内unknown回数が監査付きreset後も停止を保持。reset前の送信中operationが後からunknownになっても集計されず、reset INSERTもDB型不一致で失敗した | 停止判定を既存ledgerに統一し、全nonterminal operation解消後のみreset。監査INSERTのbytea型を修正。再起動維持・同process再開・同sessionの新規失敗による再停止を実DB検証 |
| 管理API契約 | private dashboardのURL、JSON応答、cursorがOpenAPIと不一致だった | `/admin/v1/dashboard/*`と既存schemaへ接続。summaryは署名済micro-USDCと一貫したDB snapshot、root lagは新鮮なcollector観測。欠測は503、event metadataは非公開、両listはcursor対応 |

新しい暗号方式・クライアント状態機械・財務writerは作らず、vendor/license、元RP/WP/Poseidon、layout 2、mandatory v0_buffer、ADR-0002、整数会計、永久N、sign-onceを維持する。適用済みDB migrationは変更していない。

## 検証と証跡

固定Node 24.19.0/npm 11.9.0/Go 1.25.0/Rust 1.90.0を使用。macOSではGNU tarのbinもPATHへ置く。fixtureを共有するrunnerは直列で実行する。

```sh
export PATH="$PWD/target/i08-toolchain/bin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:$PATH"
bash scripts/run_i04.sh
bash scripts/run_i06_i07.sh
python3 scripts/run_i08.py
python3 scripts/run_i09_challenger.py
python3 scripts/run_i08_wallet.py
python3 scripts/run_i08_clientd.py
python3 scripts/run_i09_operations.py
python3 scripts/check_upstream.py
python3 work/design/generate_contracts.py --check
python3 scripts/check_design.py
python3 scripts/check_evidence.py
git diff --check
```

最終結果は[I08](I08.md)、[I09](I09.md)、各runtime JSONと集約証跡に記録する。runnerごとに重複するテストは合算しない。`target/i08-i09-review-*.log`に再実行logを保存する。DB復旧の照合漏れ・timezone・pool指定は修正前の失敗も再現した。最初のI04実行はBSD tarでsource再現検査に失敗したため、GNU tarへPATHを合わせて最初から再実行した。clientd runnerはGoのsymlinkと同じdirectoryにgofmtがあると仮定していたため初回起動検査で失敗し、実体pathのgofmtを解決するよう修正して再実行した。

| 再検証 | 結果 |
|---|---|
| I04 transport/indexer/Vault回帰 | buffer 161＋既存Vault 366＋SDK 53＝実SBF 580取引、indexer 26テスト |
| 共有backend | 69テスト＋実Vault 10取引 |
| SDK/native | SDK 97、native verifier 7、native統合2、失敗/skip 0 |
| WASM/wallet | SDK 97の再検証、native 2、browser/WASM-SBF/wallet-SBF各1。新WASM payload 19取引、wallet 34取引・期待拒否2、最大423,105 CU / 1,232 bytes |
| Go clientd | race 23（subtest込み）、SDK/control 41、インストール済Go→SDK→実Vault 1。9取引、最大435,004 CU / 1,232 bytes |
| Challenger | native 18＋SDK 7、実SBF 114取引・期待拒否8、最大335,295 CU / 1,232 bytes |
| Operations | 17テスト（operations 9＋provider/collector 6＋signer 2）、同期WAL全16table比較・ack済row喪失0 |

全runnerの最終実行は失敗/除外0。型検査、fmt、Clippyも成功した。比較元はレビュー開始時のcommitで、今回の未コミット追加実装と修正を一緒に保存する。集約は[I08-I09-local-review-results.json](I08-I09-local-review-results.json)。

## 次の作業と境界

修正済みのSDK/clientd/challenger/operationsを共通のlocal基盤として使い、残る外部受入の環境・手順・予算の準備へ進める。次の順で実証を追加し、各runtime証跡にlocal fixtureとの違いを記録する。

1. 対象walletと公開RPC/clusterで入金・各退出・競合・結果不明復旧を確認する。
2. 承認されたtest credential/予算でOA-org・OpenRouter direct、3 provider proxyの推論・失効・usage・請求を照合する。
3. production KMS、OS/networkのegress隔離、独立fault domainのWAL/fencing/復旧witness保管、外部通知配送、実Tor、署名配布・対象OSの受入を進める。
4. 以上の環境と結果を揃えて全mode E2E・負荷・継続障害のI10受入を判定する。production setup・鍵・監査・公開manifestはI11の別gate。

**I10完了引継ぎReady、hosted CI成功、G1〜G4合格は宣言しない。** 実provider/実wallet/公開RPC、本番KMS・egress・別障害domain、署名配布・他OS・電源断はこのローカルレビューの合格範囲ではない。既知entropy/test keyをproductionに昇格させない。
