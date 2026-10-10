# I10 — 統合受入と外部環境の準備

2026-10-05 03:57 UTC（12:57 JST）更新：**OpenRouter proxy Chat toolsの実受入1caseが成功**。[HTTP 200・推論送信1回/再送0・`PROXY_USAGE`・18 micro-USDC請求・署名後継検証](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openrouter-tools-case-results.json)を確認し、[10,000,000 micro-USDCのdevnet入金→利用→mutual close](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openrouter-tools-runtime-results.json)も9 finalized取引・最大360,266 CU/1,232 bytesで完了した。wallet所有者がtreasury所有者を兼ねるため最終wallet 38,010,000/Vault 0となるが、明細の18 micro-USDC請求は別に検証した。[共通予算](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openrouter-tools-acceptance-results.json)は3case計57,831 micro-USDC予約・残り9,942,169。SSEはquote段階の失敗で未予約のまま。**全I10/G3と実Chrome＋Phantomは未完了**。

2026-10-05 JST、それまでの経緯：provider総額上限 **10 USDC** と **Chrome＋Phantom** は承認済み。[OpenAIモデル読取](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openai-model-access-node-results.json)と[OpenRouter通常キー読取](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openrouter-key-access-results.json)は認証HTTP 200を確認した。管理キー権限や実推論成功を示す結果ではない。最初の[OpenAI Responses試行](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openai-native-auth-initial-failure-results.json)は推論前のAUTHが不明となり、19,277 micro-USDCの試験予約を保持した。同じjournalの署名clearance→mutual closeで[10,000,000 micro-USDCのdevnet入金を全額回収](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openai-native-auth-recovery-results.json)した（9 finalized取引、最大338,395 CU/1,232 bytes、再送0）。OpenRouter plainは[実生成metadata](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openrouter-generation-usage-results.json)でnative入力14・出力2 token、実費0.0000033 USDを確認したが、計量受入は失敗し、署名済み`UNKNOWN_OPERATOR_LOSS`の利用者請求0と19,277 micro-USDC予約を維持した。原因は未確定で、推論再送・遡及課金はない。[通常SDK mutual close](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openrouter-native-withdrawal-results.json)で10,000,000 micro-USDCを全額回収した（9 finalized取引、最大355,063 CU/1,232 bytes、wallet 38,010,000・Vault 0）。これはprovider受入成功ではない。OpenRouter SSEは[quote 503](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openrouter-sse-quote-failure-results.json)で予算予約・AUTH・推論より前に停止し、未予約のまま[全額回収](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openrouter-sse-withdrawal-results.json)した（9 finalized取引、最大338,227 CU/1,232 bytes、wallet 38,010,000・Vault 0）。SSE回収時点の共通予算予約は既存2caseの38,554 micro-USDCだった。Chromeは2026-10-05 03:25 UTCにも[`ERR_BLOCKED_BY_CLIENT`](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-chrome-current-block-results.json)を再確認した。**I10全体、G3、実Phantom受入は未完了**。

未開始caseの[訂正版73件](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-quote-before-reservation-recovery-results.json)は選択caseの予約不在を必須とし、通常WalletClientの永久clearance・出金proofを維持する。[初版73件](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-unstarted-provider-recovery-results.json)は予約ありを誤って前提とした旧履歴で、[実ガード拒否](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-unstarted-recovery-initial-guard-results.json)後に訂正した。安全なquote待機の[offline47件](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-provider-quote-retry-results.json)も実provider成功ではない。

[SDK回復55件](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-sdk-unaccepted-auth-race-results.json)、[UI local 39件](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-wallet-ui-provider-local-results.json)、[表示改善後12件](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-wallet-ui-provider-phase-results.json)は各source時点のoffline検証であり、合成proof/providerやWallet Standard fixtureを含む。実Phantom・実provider受入へ読み替えない。[18ケースの準備手順](provider-acceptance.md)の最大予約合計3.833884 USDCと、全profile共通の不変予算を維持する。[7段階回帰498.224秒](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-provider-wallet-local-regression-results.json)は後続の選択profile・UI・AUTH回復変更前の履歴で、当時のsource409項目/I04入力不変とreport hash一致を保存した。

2026-10-05 JST更新（開始・既存実行は2026-10-04）。I08/I09の[local受入後レビュー](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I08-I09-local-review.md)を引き継ぎ、既存SDK、Go clientd、共有ledger、独立signer、dispatcher、indexer、challenger、実Vaultを結ぶ。I10は全modeの入金→利用→精算→出金、負荷、継続障害を検証する工程である。**本書は受入手順であり、I10完了・I10完了引継ぎReady・G1〜G4合格の宣言ではない。** 実行結果は[evidence/I10.md](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10.md)へ記録する。

正本は[実装計画](implementation-plan.md)、[運用仕様](specs/operations.md)、[API仕様](specs/api-proxy.md)、[ADR-0001](adr/0001-proof-bound-tree-transition.md)、[ADR-0002](adr/0002-build-validated-signing-keys.md)。元RP/WP/Poseidon、layout 2、mandatory v0_buffer、整数会計、永久nullifier予約、budget予約、idempotency、sign-onceを維持する。未知の推論は再実行せず、direct→proxyの切替は自動化しない。

## 1. localで先に実行する範囲

I08のGo/SBF受入は入金と出金、I06/I07はprovider HTTP fixtureと共有backend、I09はchallenger/復旧の受入をそれぞれ持つ。別々の成功を全modeの同一noteによるE2E成功へ読み替えない。

I10のlocal統合では、一つの実際に入金したnoteからSDKの実RPを生成し、実control/ledger/signerを通じてprovider adapterを使い、SDKが署名receiptと後継を検証・永続commitした後、その残高を実Vaultから出金する。既存journal/状態機械/ledgerを呼び出し、テスト側で後継や精算を代行しない。HTTP providerとfinality/RPCがfixtureである場合、その区分を各結果へ残す。専用dispatcherを通らない統合実行は、その旨を記録し、egress/fencing受入へ算入しない。

| 受入項目 | 必須の観測・判定 | 関連テスト |
|---|---|---|
| 同一noteの全経路 | finalized入金、実RP認可、推論/usage、検証済後継のcommit、clearance、実SBF出金。入金額＝利用者出金額＋確定chargeを整数で照合 | T01/T02/T19 |
| 同時認可 | 同じNへ100件を同時投入し、永久予約と上流発行が1件だけ。同じbodyは同じ結果、異なるbodyとclearance競合は拒否 | T07/T14 |
| proxy負荷 | 4並列で予約合計がcap以下、5件目制限。超過usageを利用者へ転嫁しない。nanoの合算とsession単位のmicro切上げを再計算 | T09/T10 |
| proxy切断・crash | 送信直前/直後、stream途中、usage取得後、DB commit前後を区別。再起動後も上流重複送信0、未知usageはowner終了/fence前に署名しない | T11/T13 |
| direct不明結果 | 発行応答喪失、遅延発行、disable/delete不明、usage遅延、初回key欠落を復旧。再発行/平文key再配送0、最終usageを保存して精算 | T12/T19 |
| clientとchainの競合 | wallet拒否、SDK/Go再起動、root変更、期限切れblockhash、未知executeを復旧。同一署名の確認前に新しい財務操作を作らない | T06/T17 |
| challenger | 既存AUTHとPendingの競合、過去RP＋現在zero path、deadline境界、ログ欠落、再起動、未知署名復旧。検出からfinalizedまで測定 | T14/T18 |
| DB/signer/dispatcher復旧 | 旧writer/primary/dispatcher停止と再開阻止、独立witness＋WAL＋signer journal照合、復旧後の同一session継続。二重署名/課金0 | T13/T18 |
| 秘密と配布 | DB/log/trace/backupをcanaryで確認、manifest/artifact差替え拒否。通信本文や実credentialを証跡へ含めない | T15/T20 |

一度のhappy pathは負荷試験・全crash pointの合格ではない。I10のrunnerは実行したcaseと未実行caseを分け、既存runnerのテスト件数を重複合算しない。fixtureを共有するrunnerは[既存の再現順序](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I08-I09-local-acceptance.md)に従い直列にする。

既存 I03〜I09 の test 名/source と T01〜T20 の対応、今回追加する試験の範囲は [local coverage](i10-local-coverage.md) に記録する。追加 fault suite は 12 proxy 障害、4 direct 不明結果の復旧、4 cap 超過吸収、11 writer connection 喪失を targeted run で確認した。usage 取得後・保存前の喪失と、保存済 completion を writer 再接続後に再送して重複拒否する境界を別に検査する。challenger は 8 status HTTP 503＋8 confirmed-only の別 process 復旧と、fee key 削除後の finalized 復旧を確認した。全 mode/API の 28 ケースと実 SBF escape/challenge 競合も fresh 統合実行で成功した。devnet対応前の458.202秒は[I10-local-acceptance-results.json](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-local-acceptance-results.json)に歴史的結果として保存した。その後、journal batching前sourceの全7段階を再実行して438.686秒で成功、[journal batching前report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-local-regression-results.json)と`I10-devnet-local-components/`へ別保存した。直前のPATH未固定によるNode24.13検出失敗も[失敗report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-local-regression-toolchain-failure-results.json)へ保持する。成功runは固定Node24.19.0とGNU tarのPATHを明示した。後続の追加修正前source[7段階回帰](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-final-local-regression-results.json)も399.016秒ですべて成功し、source/I04入力は不変、`I10-final-local-components/`の保存bytesはaggregateのreport hashへ一致した。

## 2. mode/APIの受入マトリクス

各行にlocal fixture結果と実provider結果の別欄を作る。モデル名、API version、料金snapshot日付/hash、実際に試したstream/tool-callの組合せを保存する。未実行欄を他providerの成功で埋めない。

| mode / provider | 利用経路 | 必須の追加確認 |
|---|---|---|
| direct / OA-org | issuer→verifier→初回限定key→直接推論→retire | station/issuer/verifierのpin、keyの期限/失効、発行不明drain、OA署名明細のidentity/amount/encodingと請求照合 |
| direct / OpenRouter | management key発行→直接推論→disable→usage→delete | 管理credentialと推論credentialの分離、遅延usageと停止後の確定条件、発行/削除の不明結果、USD厳密変換 |
| proxy / OpenAI | Chat Completions | text、client tool call、非stream/SSE、error、usage/cache、切断後の計測、cap |
| proxy / OpenAI | Responses | 上記に加えstore=false、history/background/hosted toolの送信前拒否 |
| proxy / Anthropic | Messages | text、client tool call、非stream/SSE、usage/cache、固定API version、切断後の計測 |
| proxy / Anthropic | count_tokens | 無料/運営負担、回数制限、予算を変更しないこと、未知送信の再実行禁止 |
| proxy / OpenRouter | Chat Completions | text、client tool call、非stream/SSE、routing/usageの確定条件、請求照合 |

初回release対象外の画像/文書入力、hosted tool、batch/files/画像生成/音声/Realtime、Ollama、native SOL課金を追加しない。Claude Codeなど個別クライアントの互換性はversion固定の別試験が必要で、Messages成功から推定しない。OAの明細、OpenRouter管理usage、proxy計測は異なる証拠区分のまま保存する。

## 3. 外部試験を始めるための環境台帳

公開可能な設定と秘密の参照先だけを台帳へ記録する。空欄は未準備として扱い、秘密そのものをrepo・chat・ログへ書かない。購入、契約、課金推論、公開cluster送信は、この手順書を作っただけでは実行承認にならない。

| 分類 | 実行前に記録する非秘密情報 | 未準備の場合 |
|---|---|---|
| 責任者と試験期間 | 実施者、承認記録参照、試験開始/終了、停止担当、連絡経路 | 外部実行を始めない |
| Solana | cluster名/genesis、program/pool/mint/token program、build/IDL/profile hash、RPC二系統の運営元、archive可用性、fee payer公開鍵、SOL fee/rent上限 | local SBFのまま |
| Wallet/端末 | wallet名/version、対象OS/browser/version、v0対応、明示選択account公開鍵、復旧/拒否の実施条件 | 実wallet未検証 |
| 署名・trust | manifestの独立pin/配布鍵、state/clearance/quote/receipt公開鍵、対応build、用途別秘密参照、setup区分 | 現test artifactを本番へ昇格させない |
| Provider | OA stationとissuer/verifier/inference origin、OpenRouter管理権限、各providerのtest project/account参照、credential保管参照、失効手順 | 該当modeのG3未検証 |
| モデル・料金 | 存在を確認したmodel ID、endpoint/API version、token/context限度、価格資料snapshot/hash、tariff hash、usage/請求取得方法 | fixtureの料金を実料金と扱わない |
| 費用 | provider別/総額の明示承認予算、最大request数/出力token、session cap、停止閾値、unknown/超過usageの運営負担枠、SOL fee/rent枠 | 課金呼出しを始めない |
| 運用基盤 | KMS key/workload identity参照、helper hash、mTLS peer pins、egress policy、旧resource停止/再起動禁止の制御、独立fence検証鍵 | 本番秘密管理/fencing未検証 |
| 復旧/監視 | PostgreSQL各fault domain、同期設定、backup/WAL参照、独立last-ACK witness保管先、signer journal参照、通知先/当番/配送試験記録 | RPO/RTO/SLO未達のまま |
| 配布/CI | 対象OS、署名配布物hash、SBOM/license、hosted CI run URLと対象commit | 署名配布/hosted CI未検証 |

予算はwallet/credentialの存在から推定しない。費用閾値に達した場合は新規受付を停止し、受理済みsessionの停止・usage確定・精算・出金を継続する。課金額はすべて整数micro/nano-USDCまたはproviderの厳密なUSD表現で保存し、floatの見積りを精算の根拠にしない。

**今回入力された環境と実行済み範囲**：利用者が公開 RPC と wallet key file の参照を用意し、[devnet runner](../scripts/run_i10_devnet.ts) は既存 SDK の `compileV0/signV0` を使った 0 lamport 自己送信を実 devnet で finalized 確認した。225 bytes、300 CU、fee 5,000 lamports、送信前保存、秘密鍵を読み込まない fresh process で exact-wire receipt を照合、再送 0。記録は `target/i10-devnet/runtime-report.json`。その後、専用 devnet Vault ELF を実配備し、ProgramData の ELF bytes/hash と upgrade authority を照合、Pool 初期化を finalized 確認した。配備は `target/i10-devnet-vault/deployed.json`、初期化は `initialize-receipt.json`（slot `507277497`、44,933 CU、fee 5,000 lamports）に記録した。さらに管理3命令のfinalizedと最後のunpausedを確認した。fresh wallet poolでは[実deposit→escape→finalize](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-wallet-escape-results.json)も成功した。10取引finalized、最大343,021CU/1,232bytes、1,000,000micro-USDCのwallet/Vault残高復元、ACK喪失後fresh process復旧・再送0を確認した。別runの[mutual close](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-wallet-mutual-results.json)も実control/PG/signerdのclearance署名、9finalized取引・最大347,571CU/1,232bytes、残高復元・再送0を確認。これらはwallet UIやproviderの受入ではない。RPC URL の認証部分、wallet key/path、残高を公開設定へ転記しない。providerの費用上限はその後10 USDCと承認された。OpenAIとOpenRouter通常キーの認証読取は上記HTTP 200の公開reportに記録済みで、全modeの実利用成功は未確認である。

### 公開 devnet の現在の受入欄

この表は最終成功を先取りしない。後続実行が成功した時点で、当該 scenario の receipt・source/hash・残高保存・再送数を追記する。

| 公開経路 | 現在確認した状態 | 後続実行で追記する判定 |
|---|---|---|
| Vault 配備・Pool 初期化 | 専用 program `64C2qsG8xB5XpnqiJBBDPqJqBc2P8wz73knVhFpi1PDh` の実 ELF/ProgramData 照合済み。pool `26xDwU41jfBaZK1CzANwCrb9hwTvibGusayMT1sdjUH8` の初期化 finalized | 後続取引でも同じ build/IDL/manifest/pool を維持する |
| native SDK wallet の deposit→escape→finalize | **成功**。[最終report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-wallet-escape-results.json)で10finalized取引、最大343,021CU/1,232bytes、wallet/Vault残高復元、ACK喪失後fresh process復旧・再送0を確認 | 同scenarioのnative keypair受入。readiness38,118ms、snapshot待ち合計248,683ms/最大216,874msとretry489回を保存し、latency/SLO合格にしない |
| control＋DB＋signer | [backend launcher](../scripts/run_i10_devnet_backend.py) で実 controld、専用永続 Unix PostgreSQL、独立 signerd が起動。両 RPC の devnet genesis と signer reconcile は成功。元pool待ちで `database_accepting=false` を維持し、後にclean shutdownした。実 provider adapter は0 | `target/i10-devnet-backend/runtime-report.json` の起動成功を financial admission や clearance 成功に読み替えない |
| zero-use clearance→mutual close | **成功**。[最終report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-wallet-mutual-results.json)で実control/PG/signerdのclearance署名、9finalized取引、最大347,571CU/1,232bytes、1,000,000micro-USDCの残高復元・再送0を確認 | 別run/journal、ACK喪失注入なし。実測readiness8ms・snapshot待ち合計18,022ms/最大9,130msはSLO合格ではない |
| RP 認可→escape→native challenger→後継/出金 | **成功**。challenge-liveの[wallet14取引](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-challenge-wallet-results.json)と[独立native5取引](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-native-challenge-results.json)でAUTH/event/root結合・検証済後継・出金・残高復元を確認 | native再送数は未計測。単一jobの検出→初execute送信173秒はSLOではなく、[停止時clean_shutdown=false](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-challenge-restart-results.json)も保持する |
| 不明AUTHの資金回収 | 元AUTH journalを変えず、既存stale WalletClientがpermanent clearance→mutual closeを実行。独立finalized照会でwallet/Vaultの開始残高復元を確認 | [回収report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-uncertain-auth-recovery-results.json)で9finalized取引と期限切れappend1件の置換、exact-signature再送0を照合。旧appendのreceipt/feeは未検証で、daemon challenge成功に数えない |
| 全5 mode/provider の実利用 | local fixture E2E とOpenAI/OpenRouterの認証読取を確認。初回OpenAIは推論前に中断・資金回収。OpenRouter plainは実生成を確認したが計量失敗・署名waiver 0を維持し全額回収、SSEはquote 503で予約/AUTH/推論前に停止し、未予約のまま全額回収。後続OpenRouter toolsは実HTTP 200・PROXY_USAGE/請求18・署名後継・出金まで成功 | 通常OpenRouterキーからdirect管理権限を推定しない。未準備modeのcredentialと、実usage/失効/請求照合が残る。共通総額10 USDCは承認済み。G3 未検証 |

readiness失敗は資料上も失敗として残す。元poolの後続試行は5,000slot処理後に意図的に停止し、`indexer-live-attempt-4-results.json`へ未完了を保存した。並行archive consumer下ではgetBlock4件sampleの1件がHTTP429となり、`rpc-rate-limit-observation.json`に記録、不要なconsumerを停止してfunded walletのindexerを優先した。cap4は維持し、当該sampleから一般的なRPC容量を推定しない。cap 4 の並列 archive 読取と同一 cut 照合の offline 成功から、公開 archive の処理時間や追随完了を推定しない。公開escape/finalizeとmutual closeは各最終reportで判定し、challenge-liveのdaemon challengeは独立したexact receipt照合で判定する。両walletケースはclosed/operationなし後に停止し、backendのexit0と外部indexerのSIGTERM/exit143を区別する。

## 4. 現在のコードにある配備上の制限

外部情報の入力だけでproduction起動できる状態ではない。以下は現在の実装上の境界であり、チェックを削除するだけの変更を受入対応にしない。

| 実装 | 現在の制限 | 必要になる作業 |
|---|---|---|
| `services/control/src/config.rs` | local default に加えて明示 `devnet` test profile を実装。別 IDL/ELF/build manifest hash を検査し、`local_test_only=true`、loopback listener、Unix DB、private signer を維持 | 公開実行では実 PoolConfig/ready indexer との整合と admission を確認する。設定検証だけで公開 E2E 成功にしない |
| `services/control/src/chain.rs` | local の `from_manifest` と明示 `from_devnet_manifest` を分離。devnet genesis・Circle mint・program/pool/binding と固定 profile/VK/役割鍵を検査 | mainnet拒否を維持し、公開二系統 RPC の account/finality を実行時に照合する |
| `services/control/src/bin/signerd.rs`、`egress.rs` | signerは`--local-test`、dispatcherもlocal test設定のみ | devnet testの明示起動契約でも元signer/journal/claimとprivate custodyを使う。cloud KMSをdevnet実行の前提にしない。production custodyは別受入 |
| `services/challenger/src/lib.rs`、`read_model.rs`、`runtime.rs` | 独立 manifest pin と共有 `DevnetConfig::validate_manifest` による明示 devnet trust を実装。devnet DB は Unix の SELECT-only 接続。capture した同一 cut の PoolConfig と保存履歴を照合する | 実 devnet Pending/RP/daemon challenge の統合 receipt は未取得。既存 journal/recovery を使い、第二 writer を作らない |
| `services/control/src/monitoring.rs` | local設定、数値loopback RPC/indexer、ローカル通知出力 | 公開RPCの認証済観測、独立通知receiver、遅延/欠測/配送試験 |
| `apps/clientd/companion/src/lib.rs`とprover | verifierは固定test request VKとartifact pinを検査 | 新setup時は対応する認証済build/全配布物を作り直して再検証 |
| `programs/zkapi-vault` | local固定IDは維持。devnetは公開program ID/initializerの必須build pinを追加済み。専用 ELF 配備・Pool 初期化は公開 devnet で確認済み。本番profileは未提供 | 同じbuild/環境bindingで確認した各lifecycleのreportを照合する。残る実provider利用とwallet UIを個別受入し、I11 production setup/鍵/監査は別gate |
| `packages/sdk/src/trust.ts` | devnetはHTTPS origins必須。既存2-of-3に加え、devnet/test_only/実devnet genesisに限定した `devnet_test_single_key` variantを追加済み。実PoolConfig.adminも照合 | TLSと実態に一致するauthorityを使い、ProgramData upgrade authorityは配備時に別途照合する。架空のmultisig構成を記入しない |

provider adapterには固定した実provider宛ての実装がある。承認済test credential/予算による**local service＋実provider**の限定試験は、外部配備の全制限を取り払う作業と区別できる。その結果は当該providerの実際の試験項目だけに適用し、公開wallet/clusterやproduction KMS/egress/failoverの成功としない。実API schema/料金は実施時に一次資料を再取得してsnapshotを残す。

### devnet Vault 試験に必要な最小の実装・設定

以下は実装済みの接続部、確認済みの配備、および公開 financial lifecycle の残作業である。ビルド・単体試験と実配備の証拠を分ける。

1. **program/initializer pin（実装済み）**：devnet feature は公開入力 `ZKAPI_DEVNET_PROGRAM_ID` と `ZKAPI_DEVNET_INITIALIZER` を必須とし、未設定/不正/zero/非canonical値を拒否する。local 固定 ID・initializer と production compile 拒否は維持した。選択した専用 devnet program は `64C2qsG8xB5XpnqiJBBDPqJqBc2P8wz73knVhFpi1PDh`。local/devnet各8単体試験と13負例は `target/i10-devnet-build-review/` に記録した。公開アドレスだけをビルドへ渡し、鍵ファイルは読まない。
2. **devnet ELF/IDL（生成・実配備確認済み）**：[生成手順](../tools/vault-idl/README.md)。選択したdevnet IDのcompiler-backed IDLは `target/i10-devnet-vault/vault-idl.json` に生成済みで、wireはlocal版とaddress以外同一。local IDLのbyte一致と上書き拒否も確認した。実ELFは固定 `cargo-build-sbf 4.1.0` / tools `v1.54`、`--no-default-features --features devnet,sbf-entrypoint` で別 output へ build。compiler-backed IDL 生成器にも同じ feature/ID を渡し、local fixture IDL を上書きしていない。SDK の `IDL.address == manifest.program_id` と control の build hash pin を満たす。公開 ProgramData の ELF hash `7b592cdfd750065df15d46abc54bd402877c493fd3153e1ab38982ab8f4f29a0`、upgrade authority、別枠の CLI 配備 fee/rent 上限との照合を `deployed.json` に記録した。
3. **正しい環境 manifest（作成・起動検証済み）**：`deployment_environment=devnet`、`setup_profile=test_only`、devnet genesis、Circle devnet mint、新 program/pool/PDA と再計算した vault binding、ELF/IDL/profile/PK/VK pin を揃えた。公開 test setup/署名鍵を使う限定 test pool であり、本番秘密鍵や ceremony の証拠ではない。実行した各financial lifecycleは既存RP/WP/tree proverで当該bindingのproofを作り、公開reportへ固定した。
4. **authority の実態（schema/SDK・公開照合済み）**：単一 test wallet は `{kind:"devnet_test_single_key",authority:<公開鍵>}` と明示する。devnet/test_only/実devnet genesis以外を拒否する試験を追加済みで、legacy multisigの形とmainnetの2-of-3要件は維持した。初期化 account と ProgramData upgrade authority の公開照合を行った。これをproduction multisig運用の成功としない。
5. **local service＋live chain（接続部実装・backend起動済み）**：control/challenger の明示 devnet-test trust、genesis/mint/ID/IDL の拒否条件を offline 検証した。backend は local DB/private signer を維持して起動し、2 RPC の genesis と signer reconcile を確認した。再起動器は PostgreSQL system identifier を永続 pin し、既存 DB/journal の欠落・差替えを拒否する。HTTPS は local CA をpinしたTLS frontendから既存サービスへ転送し、SDK の HTTPS 検査を維持する。公開clearance→mutual closeは別runで成功済み。後続の受理済request/Pending/challenger統合も成功し、不明AUTH回収と別reportで上表へ記録する。
6. **実 account と履歴（offline成功・公開walletでも使用）**：公開 block 内の v1 を読取だけで扱い、送信は v0 のまま維持した。indexer/challenger は先に取得した finalized account cut S を固定し、履歴を正確に S まで replay して保存 bytes と照合する。batchのslot不一致、新しいNote/Pendingの取得漏れ、tail/anchor/root不一致は拒否する。最大4並列 archive 読取も順序どおりの成功 prefix のみ反映する。対象 offline 試験は `indexer-concurrency-results.json`、`challenger-profile-results.json`、`wallet-cut-results.json` に保存した。元poolの初期replayは2回の600秒期限に間に合わなかった。instruction dataだけのBase58変換を既存lock済みnum-bigint0.4.8へ置換し、bs58との空/leading zero/不正入力・全公開payloadのbyte一致を検査した。38件とClippyの成功、63〜67倍のdecode microbenchmarkは公開readiness/SLOとは区別する。fresh wallet poolは公開deposit→escape→finalize、SDKのACK喪失復旧と最終USDC保存まで成功した。実測のread-only待ち時間を保存し、archive性能やSLOの受入とは区別する。照合条件を弱めて readiness を成立させない。

公開実行前後の差分report11件は[保存bundle](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-runtime-preparation-results.json)に保持した。immutable replay historyの毎block複製を減らす差分は40件とClippy、local状態/digest比較で検証し、cap4とrollback検査を維持する。数分の公開遅延をこのin-memory最適化だけで説明しない。I04回帰は25.972秒、後続のjournal batching前の全7段階aggregateは438.686秒で成功し、前回41.984秒とdevnet差分前458.202秒aggregateは別reportへ保存した。

後続challenge-final poolのnative read-only prewarmは600秒deadlineで停止し、durable archiveを保持、jobs/signed attemptsは0だった。[失敗記録](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-challenger-prewarm-failure-results.json)を保持する。bounded64block/8MiB journal batchingの[差分検証](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-challenger-batching-results.json)はnative29件、launcher13件、原子性・旧v1 bytes/checksum・Unknown/restart、Clippy/debug/release buildで成功した。438.686秒aggregateはこの変更前である。batching後のfresh challenge-batched poolはslot507319763から298blockを62.249秒でslot507320060までread-only prewarmしclean終了した。このprewarmを公開challengeやSLO合格にしない。後に同poolへ1,000,000 micro-USDCを入金したが、AUTHは期限切れsend_unknownとなり、受入済sessionを確認できずescapeへ進まなかった。後続の観測scanも2026-10-04 10:06:56 UTCに600秒でclean終了しjob/escapeは0。2026-10-05 JSTに元AUTHを変更せず、既存stale SDK journalで署名clearance→mutual closeを行い、独立finalized照会で開始残高への回復を確認した。照会はexecute slot507444887以降でwallet 38,010,000 micro-USDC・Vault 0、秘密鍵読取/送信0。[最終report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-uncertain-auth-recovery-results.json)では9finalized取引、最大352,891CU/1,232bytes、exact-signature再送0と期限切れappend1件の同一step置換を確認した。[先行する独立残高照会](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-balance-recovery-results.json)と最終collectorの残高照会を別時刻で保存し、元AUTHのrequest/head/stateを維持した。旧backendはclean exit0、外部indexerはSIGTERM/exit143で停止。

回収helperはDB session不在からAUTH失効を推定せず、永久AUTH/CLEARANCE排他と検証済clearanceを使う。元AUTHのexact request・暗号化record・state、stale WalletClientの保存済attemptを保持する。期限切れuploadを別枠のsuperseded evidenceへ残す場合も、全finalized plan stepと同一buffer/plan/instruction/offsetの後続replacement、新blockhash・増加したvalidityを確認し、旧receipt/feeは未検証とする。金融execute/closeの欠測、不明RPC、未確定uploadには適用しない。offline6件とstrict tscは[検証report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-clearance-recovery-validation-results.json)、exact AUTH限定retryのoffline7件は[別report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-auth-retry-validation-results.json)へ保存した。後続challenge-liveは、受理済AUTH/zero-use精算→stale SDK escape→独立native daemon challenge→検証済後継のmutual closeまで成功した。[wallet report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-challenge-wallet-results.json)は14finalized取引・最大353,022CU/1,232bytes・残高復元・exact-signature再送0、[native collector](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-native-challenge-results.json)は別の5finalized取引・最大323,571CU/1,232bytesと正確なAUTH/payload/event/root照合を記録する。native再送数は未計測、検出→初execute送信173秒はfinalization latency/SLOではない。

[停止・再読込](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-challenge-restart-results.json)は強制cleanup後のclean_shutdown=falseを保持する。20秒の猶予を持つlauncherでgraceful終了は確認できず、同journalのchecksum/semantic再検証成功とも区別する。[collectorのoffline9件](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-devnet-challenge-collector-validation-results.json)はbounded local journal読取とcanonical field0/vault・field9/operation照合の検査であり、ELFやchain protocolは変更していない。追加provider/Phantom/停止修正前の[全7段階回帰](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-final-local-regression-results.json)は399.016秒で成功し、component結果を`I10-final-local-components/`へ分離保存した。438.686秒はjournal batching前の履歴であり、現在の成功へ読み替えていない。

この devnet 作業に production ceremony、cloud KMS、遠隔 fault domain、第三者 audit を要求する必要はない。それらは別の公開条件であり、I10 の実devnet経路を実装する作業を止める理由にはしない。既存SDKの財務状態機械、共有台帳、暗号・fencingの検査を迂回して成功と記録しない。

## 5. 実行順と保存する証跡

1. localの同一note統合を各mode/APIで実行し、失敗caseを修正する。各報告に実component/fixtureの境界、case ID、source/lock/binary/manifest/PK/VK/IDL hash、command、開始/終了、exit codeを保存する。
2. 承認された対象wallet/公開clusterを用意し、環境別buildとtrustを検証する。全命令/v0 buffer、最大CU/bytes、stale root、拒否、未知結果、再起動を実際のtransaction receiptで確認する。
3. test credential/予算の承認記録と料金snapshotを揃え、上記全provider matrixを実行する。request ID、冪等性、発行/失効、usage、署名receipt、請求照合を結び、prompt/response/token/keyを証跡に保存しない。
4. 単発caseの後で負荷/継続障害を実行する。負荷量、同時実行数、継続時間、seed、RPC/provider遅延条件を先に固定し、p50/p95、RSSの測定対象、失敗/再proof/再送数、収支、ack喪失数を保存する。少数sampleからproduction SLOを宣言しない。
5. 独立fault domainで旧primary/writer/dispatcherをfenceし、同期WAL、last-ACK witness、signer journalから復旧する。停止から安全な受付再開までをRTOとし、ACK済予約/課金の喪失0を確認する。昇格時間だけを全復旧RTOにしない。
6. 実Tor、対象OS/端末停止、署名配布、KMS、egress遮断、外部通知、hosted CIを個別に確認し、I10結果と残るI11項目を更新する。

`target/`の生成物は後続runnerで上書きされ得る。新しい実行は古い`passed`を引き継がず、当該runのartifact/report/logをhash付きで保存し、入力生成と実行の順序を記録する。失敗/中断/除外も残し、成功した別runと混ぜない。`scripts/check_design.py`と`check_evidence.py`は仕様/保存hashの整合検査で、runtime・証明・provider合格の代替ではない。

## 6. 残るgateの判定

| Gate | 現在確認した状態 | 合格に必要な未完了範囲 |
|---|---|---|
| G1 | local実暗号/SBF/v0と公開devnetの配備・管理・escape/finalize・mutual close・独立native challengeを確認。wallet最大353,022CU、native最大323,571CU、各最大1,232bytes | native keypairの成功を対象wallet UI/v0署名端末の受入へ広げない。G1全体の判定は既存要件と対象wallet受入へ照合する |
| G2 | 既存の全mode/API local統合・exit競合・fault/stress、公開ACK喪失復旧・RP/exit/native challenge・不明AUTH資金回収、同journal再読込を記録 | 追加provider/Phantom/停止修正前の[7段階local回帰](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-final-local-regression-results.json)は399.016秒ですべて成功。native停止時clean_shutdown=falseと未計測再送を保持し、検証済項目からgraceful停止や未知txの公開crash復旧を推定しない |
| G3 | OpenRouter proxy tools 1case成功、全体は未完了 | OA-org・OpenRouter direct、3 provider proxyの実credential・stream/usage/失効/請求照合。利用不能なmodeは未合格を維持 |
| G4 / I11 | 未検証 | 3回路production setup/transcript、用途別鍵/multisig、第三者review、production復旧/監視/当番、署名配布/公開manifest |
| I12 | 未着手 | I11後の別配備作業。mainnet署名/送信/実receiptを本書やlocal成功から実行しない |

I10の部分受入は項目ごとに記録し、未実行項目を除外してI10完了としない。現在はdevnet RPC/native wallet smoke、専用Vault配備・Pool初期化・管理命令・実deposit→escape→finalize/ACK喪失復旧、local backend起動と停止まで確認済みであり、別runのmutual closeも確認した。公開native daemon challengeと検証済後継の出金も成功した。I10の残件は実provider/G3とwallet UIの受入であり、I11公開運用は別工程として分ける。追加provider/Phantom/停止修正前のlocal一括回帰は399.016秒で成功したが、local fixture結果を実providerやwallet UIの合格へ広げない。公開test entropy/鍵をproductionへ流用せず、local合成mint・Circle devnet mint・mainnet mintを混同しない。
