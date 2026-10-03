# I05 — Postgres ledger・quote・signer 実装引き継ぎ

2026-10-04 JST。**I05はlocal実装・検証完了**。[完了記録](evidence/I05.md)に実行コマンド・artifact・制限を記録した。本書はI05の実装契約を保持し、I06 direct・I07 proxyのprovider adaptersへの引き継ぎにも用いる。26テストと実Vault SBF 10取引（最大422,429 CU / 1,091 bytes）が成功し、新signer署名から利用者4,999,998 micro-USDC・treasury 2 micro-USDCの出金まで確認した。実provider・wallet・公開RPC・hosted CI・G1〜G4は未完了。[I04レビュー記録](evidence/I04.md)の修正を前提にする。正本は[API・精算仕様](specs/api-proxy.md)、[運用仕様](specs/operations.md)、[protocol](specs/protocol-solana.md)、[OpenAPI](contracts/openapi.json)、[ledger DDL](contracts/ledger.sql)。以下の着手順序・統合境界・完了条件は受入契約として維持する。実装の現在地と実行結果は完了記録を正本とする。

2026-10-04のレビューで、最終dispatch claim、direct key管理参照の永続化、signerのquote/料金表結合、journal破損判定、障害中の復旧、RPC origin重複、料金表の有効期間の7件を修正した。[レビュー証跡](evidence/I05.md#2026-10-04-レビューとi06i07への引き継ぎ)の26テストと実Vault SBF再実行を根拠に、**I06/I07実装着手Ready**とする。

## 1. 成果物と範囲

`services/control/`にRust/Axum/Tokioの制御API、Postgres ledger writer、別processのBaby-JubJub signerとその永続journalを実装する。versioned migrations、local test設定、再現script、CI job、`docs/evidence/I05.md`を成果物とする。既存workspaceのRust 1.90.0とArkworks 0.5系列を維持し、新規DB/HTTP依存は実build後にlockする。PostgreSQLは既存contracts CIの16系列を開始点とし、実行した正確なserver versionを記録する。

必須公開APIはconfig/catalog/tariffs/quotes、session作成・状態・close・operation状態・receipts、clearance、nullifier状態。tree APIはI04 indexerを利用する。catalogには実際に利用可能なadapterだけを公開する。I05のlocal adapterは明示的なtest設定でだけ使用し、provider未実装を成功応答や実キー発行と扱わない。

I05はdirect/proxyの共通台帳・状態遷移・dispatch契約まで担当する。実OA-org/OpenRouter発行はI06、推論/SSEとusage正規化はI07、browser秘密storage・note journalはI08、常駐challenger/本番復旧はI09。I05でlocal test dispatcherの実process停止と再開拒否を検証しても、provider egressや本番failoverのgateは合格にならない。

## 2. 再利用する実装

| 再利用先 | I05での用途・制約 |
|---|---|
| [整数/H2F型](../crates/zkapi-solana-types/src/lib.rs) | `MicroUsdc`、canonical Fr/Scalar、binding、予約・session丸め。料金の有理数集計/JCS/strict HTTP parserはI05の`services/control`へ追加済み |
| [crypto adapter](../crates/zkapi-solana-crypto/src/lib.rs) | 元proofのcanonical decodeと固定VK検証。requestは12 public inputs。ユーザー指定VKを受け付けない |
| [固定upstream v2](../vendor/ethereum-zkapi/protocol/rust/crates/zkapi-core/src/v2.rs) / [compact署名・commitment](../vendor/ethereum-zkapi/protocol/rust/crates/zkapi-proof/src/compact.rs) | 元authorization_tag、state/clearance_message、server_update、next_anchor。既存Ethereum processorの「署名後に保存」やSQLite lockを移植せず、Solanaの永続化順序を実装する |
| [Vault](../programs/zkapi-vault/src/accounts.rs) / [生成IDL](contracts/zkapi_vault.json) / [ADR-0002](adr/0002-build-validated-signing-keys.md) | 実PoolConfigのbinding・cap・state/clearance鍵・profile、ExitNullifier/PendingのPDA/owner/layoutを照合。measurement accountを読まない |
| [indexer](../services/indexer/README.md) | 同slotの実account照合済みfinalized root。`replay_state()`は照合前にも読める内部値なので認可には使わない。snapshotに全ExitNullifierは含まれない |
| [SDK transport](../packages/sdk/README.md) / [host tree prover](../crates/zkapi-tree-prover/src/lib.rs) | 実SBF統合fixture、入金と後継状態からの出金確認。通常SessionCreateにtree proof・note ID・walletを加えない |

test用の公開鍵・既知entropyはlocal限定。manifest、実PoolConfig、role別build pinとsigner公開鍵が一致しなければ起動拒否。別state/clearance鍵の生成を既存poolの鍵交換として扱わない。quote/receiptは別Ed25519鍵、state/clearanceは元Baby-JubJub。

I04の`observe_chain`はtree復元に必要なaccount検査であり、PoolConfigのmint/token program/binding/署名鍵/cap/pauseを制御API向けに検証・提供するものではない。I05自身がtrusted manifestと実PoolConfigの全認可設定を照合する。healthy indexerだけでこの検査を代替しない。

## 3. 実装順序

| 順序 | 実装 | 着手時から必要な検証 |
|---|---|---|
| A | Postgres migrations、writer接続・role分離、epoch、signer journal用migration | 空DB適用・再起動・適用済みchecksum不一致拒否、runtime roleのDELETE/TRUNCATE/DDL拒否、lock接続喪失時の書込み停止 |
| B | strict型、JCS、tariff/quote発行・署名、AuthorizationBody/public input binding | 重複key/未知field/不正UTF-8/float/非canonical値拒否、固定vectors、mode/provider/料金表/origin改変拒否 |
| C | 認可・clearance予約、二重RPC exit照合、冪等回復 | 実request proof、同N同時100件、AUTH対CLEARANCE、同request/別digest、quote再利用、期限・rootの待機中変更 |
| D | session/operation/dispatch遷移、整数予算、署名receipt | 並列4枠とcap、未送信0課金、UNKNOWNの再dispatch禁止、終了/fencing前の精算保留、明細合算 |
| E | SIGN_PENDINGの対象固定、独立signer、回復 | 各crash pointで別charge/anchor/role/requestの署名拒否、0課金でも後継1つ、実署名を元回路とVaultで利用可能 |
| F | HTTP統合・再起動・障害注入・CI/evidence | 永続Postgresと別process signerを使い、DB/log/traceに秘密や本文がないことを検査。mock範囲を分けて報告 |

### 認可とchainの境界

1. strict parserで16 KiB上限とtokenを検査し、quote・AuthorizationBodyからH2F/contextとauthorization_tagを再計算する。RPのversion/namespace/binding/keys/time/capを比較する。`RP.solvency_bound == quote.cap_micro_usdc == PoolConfig.cap`を要求する。
2. 保存済みrequestはcredentialと全body/proof/public inputs digestを照合して復旧する。受理済みquoteへの期限・root鮮度の再適用や、upstream key再送はしない。
3. 新規だけ、実proof検証と照合済みrootの取得、独立2 RPCのconfirmed exit照合を行う。context slotがrootのfinalized slot未満、RPC不明、indexer 503/照合不一致なら503。以前取得したrootやDB checkpointを使って停止中のindexerを代替しない。片側でもexitを観測したら拒否する。`(pool, RP[8])`からExitNullifier PDAを導出する。escapeは同一transactionで永久tombstoneを作るので、通常認可へnote IDを追加してPendingを逆引きする必要はない。
4. ロック取得後、既存予約を再照会してからquote期限・pool受付・quote未使用・root観測の有効性を再検査し、N/quote/session/transcriptを一括commitする。proof/RPC検証前の時刻を使わない。競合rollback後は同じdigestの保存済み結果を取得する。
5. ACTIVE化/direct発行直前とkey返却直前にもexitを確認する。chainとDBの原子性は成立しないので、競合観測時は新規利用を停止し、保存済みRP/proofをchallenger向けoutboxへ残す。I05でexit照合を省いてI09待ちにしない。

### DB transactionと外部送信

- 財務更新はpool advisory lockを保持した同じ専用connectionで直列に実行する。HTTP handlerごとのconnectionやin-memory mutexだけに依存しない。pool受付/epoch、session行、operation行の順で必要なlockを取得し、同じ順を全writer操作で守る。
- 存在しないN行の`SELECT FOR UPDATE`は排他を作らない。`nullifier_reservations`の主キーとAUTH/CLEARANCEの外部キーを使い、INSERT競合をtransactionごとrollback/再読込する。予約は署名が未完でも削除しない。
- 受理後のsessionのpool/request/N/quote/digest/transcript/credential hashes/mode/provider/capと、quote/tariffのcanonical bytesは固定する。契約DDLだけではこれらすべてのUPDATEを防がないため、I05追加migration/role/repositoryで強制し、書換え拒否を試験する。signerはtranscriptと固定poolからmessageを再導出し、保存digestだけを信頼しない。
- 予算受付とdispatch直前のCASで、row lock取得後の実時刻・ACTIVE・close_requested・並列枠・capを検査する。DISPATCHINGとimmutable attemptを一括commitしてから送る。commit結果不明なら再照会し、再dispatchしない。
- dispatcherは保存したattempt/owner/epochを検査し、外部送信能力を単一ownerへ限定する。`finished_at`/`fenced_at`は実停止の証拠を必要とする。期限・DBフラグだけでfence完了としない。
- 最終send claimでもpool受付とsession/operation状態を照合し、停止済みpool・UNKNOWN operationへ送信許可を出さない。directで判明した管理参照は最終chain確認をawaitする前にcommitし、確認失敗・キャンセル後も失効/最終usage取得へ利用する。保存済み参照の再試行ではkey返却のための再activateをしない。
- RPC/indexer障害では新規受付を停止し、保存済みsettlement/clearanceの復旧は継続する。観測したgenesis/PoolConfig不一致は起動拒否。2 RPCは正規化したoriginも分離する。quote/catalogは現在有効な料金表だけを選び、受理済みquoteの旧料金表を保持する。
- [DDL](contracts/ledger.sql)のCHECK/triggerは金額域・一意性・署名対象不変性の一部を守る契約。全状態遷移、receipt合計、role権限、egress fencing、migration/version、独立signer journalはI05で追加・検証する。DDL smoke testだけでは完了しない。

### 署名対象と復旧

RECONCILINGのsessionをロックし、terminal operations・予約0・全attempt終了/fencing・全charge receipt署名と合算を再確認する。利用者nanoの合計を一度だけmicroへ切り上げ、cap以下を確認する。CSPRNGでcanonical scalarのblind deltaを生成し、元`server_update`で`E_next = E_anon − charge·G + blind_delta·H`、元`next_anchor`と新しい乱数でanchorを生成する。

`settlements`へcharge/anchor/E_next/delta、元`state_message(2, 0x534f4c, vault_binding, E_next.x, E_next.y, anchor)`のcanonical BE32とSHA256を保存し、同じtransactionでSIGN_PENDINGへ進める。乱数・anchor・署名対象をretryごとに作り直さない。clearanceも元`clearance_message(2, 0x534f4c, vault_binding, N)`を再計算し、永久CLEARANCE予約と保存digestを照合する。DBのSchnorr署名は`R.x || R.y || s`の96 bytes BE、HTTPはOpenAPIのobject。座標とscalarはそれぞれの法で検証する。

signer RPCへは対象IDを渡し、任意messageを直接署名するAPIを設けない。signerはprimaryの固定対象と準備条件を独立に再確認する。ledgerと別に保持するjournalは`(pool,N)`で一意、kind・request ID・鍵・messageをpinし、署名前に同期永続化する。署名後もjournalへ同期保存してから返す。writerが署名を検証・DB保存した後にSETTLED/clearanceを公開する。ledger restore後の同N/別requestやAUTH/CLEARANCE変更はjournalでも拒否する。journalに対応するledger対象の欠落/不一致、署名済みledgerに対応するjournalの欠落は署名停止とする。初回の未署名対象は新規intentを保存可能であり、未署名intentは同一対象だけ再開し、journalの保存済み署名はledgerへ回復する。消失したjournalを空で再初期化しない。

## 4. 必須の完了証拠

以下を`docs/evidence/I05.md`に実行コマンド、正確な依存version、fixture/hash、期待拒否、local/実環境の区分とともに残す。

- T02/T07/T08：実proofの受理、各binding改変拒否、同N 100並列、AUTH/CLEARANCE競合、同request別body拒否、受理済み期限切れ復旧、ロック待ち中のquote失効。
- T09/T10：実Postgresのrow lock下で4並列予算、5件目制限、期限等号/待機中close、nano有理数合算・単回micro切上げ、cap超過の運営負担、direct USD lexemeの厳密変換。
- T11/T13/T18のI05範囲：DISPATCHING前後・SIGN_PENDING後・署名後・DB保存後のprocess kill/restart、旧writer接続kill、未fence時署名保留、local owner停止後の再開拒否、ledgerだけを巻き戻した際のjournal照合拒否。provider/本番network fencingとは区別する。
- T14：実VaultのExitNullifier bytesをlocal RPC fixtureで返し、片側exit・古いslot・不正owner/PDA/layout・RPC不明で新規認可/有効化を止める。real cluster競合は後続gate。
- T15/T19：receipt署名/整数再計算/途中cursorの未署名飛越し拒否、0課金・unknown・late loss区分、DB/log/traceへの本文・生credential非保存。
- 実crypto連結：quote結合RPで認可→使用料確定→署名保存→後継stateを使う次のRPとclearance付きWPを生成・検証し、WPとtree proofを実Vault SBFへ送って整数残高を照合する。既存I03の固定署名fixtureだけで新signer合格にしない。
- migrationsの適用・再実行・version/checksum不一致・runtime role権限を実Postgresで検証し、起動不能時に新規受付/署名を始めない。

I05のruntime再現コマンドは`bash scripts/run_i05.sh`。実Postgres・独立signer/dispatcher process・実Vault SBFを用いる。local実行手順は[control README](../services/control/README.md)、完了証拠は[I05](evidence/I05.md)を参照。`python3 scripts/check_design.py`と`python3 scripts/check_ledger_contract.py`は仕様/DDL検査でありI05 runtime試験の代替ではない。既存I04回帰は`bash scripts/run_i04.sh`で再現する。I05 CI jobは追加済みだが、hostedで未実行の結果を合格にしない。live provider・wallet/RPC、production setup、hosted CIとG1〜G4はそれぞれ実証されるまで未合格を維持する。
