# I08/I09 実装開始契約

追加実装後のレビュー修正・再検証・次の作業は[local受入後レビュー](evidence/I08-I09-local-review.md)を参照する。I10完了引継ぎReadyは宣言しない。
**現在の受入は[I08/I09 local実装・受入](evidence/I08-I09-local-acceptance.md)、[I08](evidence/I08.md)、[I09](evidence/I09.md)を参照する。** 本書は実装前・初期レビュー時の契約を保持したもの。下記の「未完成」「再開位置」は当時の状態であり、実装の重複や現行機能の削除を指示しない。I10への完了引継ぎと公開gateは引き続き未承認。

2026-10-04 JST。I06/I07の7件のレビュー修正と59テスト・実Vault SBF 10取引の再検証を[I06](evidence/I06.md)・[I07](evidence/I07.md)に記録した。**I08/I09のlocal実装着手Ready**とする。本書は**次工程の実装着手契約**であり、I08/I09の実装完了・本番公開を示さない。正本は[API仕様](specs/api-proxy.md)、[tree-transition](specs/tree-transition.md)、[protocol](specs/protocol-solana.md)、[operations](specs/operations.md)、[OpenAPI](contracts/openapi.json)。[I06/I07引き継ぎ](i06-i07-implementation-ready.md)と[I05の台帳・signer契約](i05-implementation-ready.md)も維持する。

## 1. 開始位置と変更範囲

| 工程 | 既存の接続先 | 新しく実装するもの |
|---|---|---|
| I08 SDK | `packages/sdk/src/{encoding,layout2,transport}.ts`、generated IDL、control API・provider adapters | manifest信頼検証、端末内crypto/WASM worker、暗号化note journal、制御API client、署名/receipt検証、wallet利用フロー |
| I08 clientd | 固定vendorの`zkapi-clientd/`、`protocol/rust/crates/zkapi-client/`・`zkapi-browser/`、元SDKのworker/store/recovery | `apps/clientd/`へのGo移植、Solana用Rust companion、loopback互換API、明示mode選択、native配布 |
| I09 challenger | `services/indexer/`、controlの保存済みRP/proofと`CHAIN_EXIT_OBSERVED`、host tree prover、Vault challenge命令 | `services/challenger/`、継続監視、証拠照合、永続送信journal、期限再送・通知 |
| I09 operations | 単一writer・immutable dispatch attempts、独立signer journal、direct checkpoints、署名receipt | dispatcher分離・egress fencing、復旧runbook、監視、private dashboard、配備用secret境界 |

固定upstreamは`ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`。vendor/licenseを保持し、移植したpathとEthereumとの差分を証跡へ記録する。Ethereum wire・RPC・native ETH支払いをSolanaへそのまま接続しない。USDC整数、元request/withdrawal/Poseidon、32段tree、layout 2、transition_proof/proof_bound、v0_buffer、ADR-0002の役割別鍵を再選定しない。

SDKはI04 transaction transportに加え、I08のmanifest信頼検証・暗号化storage・note/session journal・control client・native verifierを実装済み。[I08の証拠](evidence/I08.md)を正本にし、これらを再実装しない。`EncryptedTransportJournal`で`Journal.save`を永続化できるが、実wallet/proverを接続した製品フローは未完成。既存in-memory test callbackを製品storageとして扱わない。hostの`tree-prover`には、I08/I09が独立trust anchorから検証したprofile/artifactだけを渡す。

### 2026-10-04レビュー後の再開位置

[レビュー記録](evidence/I08-I09-review.md)に修正と再検証を記録した。**I08/I09の継続実装へ着手可、I10全機能E2Eへの完了引継ぎは未達**。次の変更は以下の順で、既存journal・transport・read modelへ接続する。

1. **I08 C/D**：既存暗号journalへprover用note witnessとwallet操作を接続する。現`PrivateState`の残高/署名だけで秘密note全体を保存済みと扱わない。clearance取得/検証、実RP/WP/tree生成、WASM worker失敗時のnative代替、finalized入金・出金・escapeとstale-root再proveを実行する。
2. **I09 A/B**：RPC scan/restartと永続checkpointを接続し、I04の署名検証済みv0 bytesをchallenger journalへ送信前保存するbroadcasterを作る。今回の新payload SBF検証はproof/wire/chain条件の検査であり、daemonや署名照会/同一bytes再送の完成根拠ではない。未知署名が残る間は別job/payload/signatureを作らない。
3. **I08 E/F**：同じclient状態機械を使うGo loopback daemon、権限分離、key reuse/close、SSE、Tor remote DNS、secret custodyと配布へ進む。
4. **I09 C/D/E**：専用dispatcherと独立egress fencing、ack済み予約/WAL/signer照合の隔離復旧演習、admin ACL/監視/KMS/mTLSを順に実装する。test用`LocalOwner`を実egress fencingと読み替えない。

I10のテスト設計・fixture準備は並行可能だが、I08 D〜FとI09常駐送信/C〜Eの受入証拠が揃うまではI08/I09完了やI10/G1〜G4合格を記録しない。実provider credentialやpublic RPCがなくても、上記local実装・障害注入は進められる。

## 2. I08の実装順序と受入条件

| 順序 | 実装 | 完了に必要な証拠 |
|---|---|---|
| A | 信頼済みmanifest/PoolConfigと3回路のartifact検証、既存native cryptoへのbridge | 配布物の信頼鍵または事前pin hashを起点にJCS hash/署名、genesis/program/pool/mint/token program、role別鍵、IDL、profile、PK/VKを照合。不一致・環境混在・改変artifactを拒否 |
| B | 暗号化storage adapterとnote/session/transaction journal、排他 | browserのtransaction/CASとタブ間排他、nativeのfsync/atomic replaceとprocess排他。各境界の停止・再起動・競合で同一noteを二重に進めない。backupの復元も同じ検証へ通す |
| C | quote/認可/close/recover/receipt APIと状態検証 | 実RPでquote・mode・料金・credentialを結合。同一request/proof/tokenで復旧し、後継署名・commitment・整数残高・全charge receipt合計を検証してから新stateへ進む |
| D | browser workerとwallet入出金・escape | 元RP/WPとtree proofを生成しローカルverify、I04 transportでv0送信。worker停止・wallet拒否・stale root・expiry日境界・不明送信を復旧。native代替経路を実行確認 |
| E | Go clientdとRust companion、4推論API/count_tokens/SSE | 127.0.0.1:8787、Host/Origin検査、推論credentialとwallet管理credentialの分離。direct/proxyの明示設定、key reuse default 60秒/0でrequest毎、終了時close、stream切断・再起動を検査 |
| F | 利用者表示・Tor/SOCKS5・配布 | proxyの本文閲覧可能性、expiryと7日前/1日前警告、Active期限切れ時の元本全額treasury移転を表示。remote DNS/fail closedをcontrol/provider/indexer/RPC/companion各経路で検査。native binary/hash/依存lockと実行OSを記録 |

A→B→Cを最初の縦断実装にし、同じ永続状態をD/Eから使用する。browserとclientdに別の認可・会計状態機械を作らない。P04/P23〜P28/P33/P36、T02/T08/T10/T12/T15〜T17/T19/T20、TT07のI08範囲を検証する。

### note journalと配信回復

- 認可前にrequest UUID、利用者生成control/proxy secret、exact quote/AuthorizationBody/proof、料金表を暗号化して保存する。通常SessionCreateへnote ID、tree proof、wallet情報、promptを追加しない。
- note単位の未精算認可は1つ。`未送信 → 送信不明 → 受理/利用中 → 精算待ち → 署名検証済み`を永続遷移させ、旧stateと未解決操作を保持する。破損・古いbackup・競合revisionでは新規認可を止めて照合する。
- directのplaintext keyは初回応答だけ。応答喪失・202・key欠落では保存したcontrol credentialでclose/recoverし、再発行やproxy切替をしない。再送POST/GETからkeyが返ると仮定しない。keyを保持する場合も端末内の暗号化storage限定。
- proxyでは送信前にoperation UUIDとexact request bytesの照合情報を保存する。本文を永続化する必要がある場合は利用者端末の暗号化storageで扱い、serverへ復元用本文を保管させない。同じIDで異なるbytesを作り直さない。409はstatus URLへ進み、応答本文は再取得不能と表示する。新IDでの再推論は利用者の明示操作とする。
- Ed25519 quote/receipt署名とBaby-JubJub state/clearance署名を区別する。料金表のhash・quote結合、request/pool/deployment/operation、receipt重複・欠落・cursor、nano整数再計算を検査する。microへの切上げはsession全体で1回。`late_loss_observation`をchargeへ合算しない。
- `SETTLED`文字列だけで残高を更新しない。`E_next = E_anon − charge·G + blind_delta·H`、anchor、state署名と新秘密状態の整合を確認し、新stateの永続commit後に利用可能にする。0課金・unknown waiverでも後継は1つ。

### proof/transaction復旧

`crates/zkapi-tree-prover`のprepare/load_pk/prove/verify、`zkapi-layout2`と生成IDLを再利用する。browser用bridgeは実WASM buildと実proofを検証する。既存vendor WASMの存在だけでSolana用worker完成とはしない。request/withdrawalの秘密witnessは端末内限定、tree witnessは公開Note/pathだけとする。

I04の`prepareAttempt`/`recoverAttempt`とstandalone finalize用journalを暗号化storageへ接続し、署名bytesの永続化完了前にRPC送信しない。結果不明の財務execute/close/finalizeでは同じ署名bytesの照会/再送のみ。blockhash expiry・account欠落だけで未成立を推測しない。uploadは既存`refreshExpiredUpload`の条件（finalized blockheightで旧hash失効、同一bufferのowner/digest/offset/seal検証）を満たす場合に限り、新blockhashでappend/sealを継続または確認済みprefixの次段へ進める。buffer欠落から新createを許可しない。確定失敗がstaleなら最新root/pathで再生成し、新digest/bufferへ進む。close/escapeではWPも再生成し、clearance/Nは維持。depositはnext IDとClock由来expiryを再検査し、finalized成功を確認して初めてnote ID/残高を利用可能にする。send応答やconfirmedだけで入金を確定しない。finalizeにはtree proofを要求しない。

## 3. I09の実装順序と受入条件

| 順序 | 実装 | 完了に必要な証拠 |
|---|---|---|
| A | challengerの独立read modelとchain監視 | finalized Pending/Noteを検証し、`(pool, Pending.nullifier)`で永久AUTH予約・保存済みtranscriptと照合。settled sessionも対象。root/slot不一致・欠落証拠で誤送信しない |
| B | challenge生成・永続queue・v0送信回復 | 過去RP/proofと現在zero pathで実tree proofを生成・verify。実Vault SBFでroot変更後のchallenge、再起動、送信不明、deadline等号、pause、tombstone維持を確認 |
| C | owner停止/fencingとdispatcher分離 | provider credential/egressは専用dispatcher限定。旧writer/primary/dispatcherを止める独立証拠をattempt/epoch/ownerへ結合。旧ownerを再開しても送信不能、fence不能なら新規受付/署名保留 |
| D | signer/DB復旧とbackup/WAL照合 | 既存journalとの一致、ack済み予約の復元、migration checksum、RPO/RTOを隔離演習で実測。単一writerを維持し、同期replica/failover・split brainを検査 |
| E | private dashboard・監視・配備secret | admin専用Bearer＋network ACL、summary/recent/eventsの秘匿、期限とlag・unknown/loss・予算・signer・SOL残高の監視。KMS envelope/mTLS・鍵役割分離の設定と失敗時停止を検証 |

A/BとI08 A/Bは並行着手可能。共通のmanifest/prover/transport契約を先に固定し、C/Dは一つのledger writerを通す。P29〜P31/P36、T11/T13〜T15/T18〜T20、TT07のI09範囲を検証する。

### challengerの証拠・送信契約

`CHAIN_EXIT_OBSERVED`はcontrolが認識した競合の通知であり、全escapeの一覧ではない。outboxだけに依存せず、継続chain scanからPendingを検出する。通常認可にnote IDを要求せず、chainのPending Nと保存済みRP[8]で照合する。`DIRECT_RECOVERY_CHECKPOINT`はdirect管理用でありchallenge eventとして消費しない。

challengerは`Ledger::connect`で第二writerを取得しない。最小権限read connection/repositoryと独立のchallenge job/checkpoint storageを追加する。財務状態変更は既存writerの検証済み操作へ委譲し、署名journalやprovider checkpointを書き換えない。outbox consumer cursorはconsumer別に保持し、delivery印や時刻だけで完了としない。新schemaが必要なら追加version migrationにし、適用済みmigrationを書き換えない。

confirmed検出は早期準備用。送信時はfinalizedの実PoolConfig/Note/Pending/current treeと照合し、過去RP/proofを固定VKで検証する。RP rootとcurrent rootまたはPending.old_rootの等号を要求せず、quote/request時刻の現在freshnessも再適用しない。treeは現在Pendingのzero path、同NoteのC/D/expiryによるrestore。root競合ではtree proofだけを再生成し、RP/N/request_timeを変更しない。

jobはpool/note/Nと観測したPending世代・deadlineへ結合し、証拠digest、slot/blockhash、transaction/instruction/CPI順序、tree sequence、payload/digest、buffer、全署名attemptを永続化する。finalized成功を確認してから完了。再起動時は旧署名の成否照合を先に行い、結果不明の財務executeを別署名で再実行しない。確定失敗後の再生成と、未知署名の継続照会を区別する。

24時間challengeに対して検出→prove→buffer→送信5分以内を目標とし、遅延60秒警告、5分当番通知、残り1時間緊急を実装する。deadline等号ではchallenge不可。単一proof時間だけで目標達成としない。root競合、queue待ち、RPC停止、再起動を含むp50/p95・メモリー・再生成回数を記録する。常駐workerが停止してもnative CLIから生成・送信・復旧できる経路を試験する。

### dispatch/運用境界

現行`controld`はloopback/test-onlyでcontrolとprovider taskが同process。旧epochのattemptは再起動だけで終了扱いにできず、受付・署名を停止する。`dispatcher::LocalOwner`は試験用子processの停止証拠であり、実provider taskのegress停止証拠ではない。I09は配備基盤による停止/再起動禁止またはegress遮断を実装し、独立証拠を`FenceEvidence`へ渡す。

proxy unknownはowner終了/fence後のdrain時のみwaiver、directは鍵停止・最終usage・削除まで保留。provider新規受付停止とpool停止を分け、既存精算/退出は継続する。現在のunknown回数による停止はprocess内の一時状態なので、永続監視・閾値・再開判定をI09で追加する。OAのusage証拠とOpenRouterの安定観測をproviderの暗号学的最終性と表示しない。

## 4. 実行と証跡

開始時のbackend回帰は`bash scripts/run_i06_i07.sh`。使い捨てPostgres・実RP・別process signer・provider模擬HTTP・実Vault SBFを用いる。SDKの現状確認は`npm run typecheck && npm test`。必要なI04統合回帰は`bash scripts/run_i04.sh`。これらはlive provider/公開RPC/walletの代替ではない。

I08では`docs/evidence/I08.md`、I09では`docs/evidence/I09.md`にcommands・exact dependencies・artifact/source hash・実行OS/ブラウザ・件数・失敗/除外・性能・未検証項目を記録し、専用の再現script/CI jobを追加する。native/WASM/SBFの実proof結果とfixture state-machine試験を分ける。設計検査・schema検査の成功だけでruntime完了を宣言しない。

local着手に実credential購入やmainnet鍵は不要。実provider請求照合はI10/G3、production setup・監査・multisig・公開manifestはI11/G4。I09の本番egress/failoverをlocal模擬試験だけで達成済みとしない。実wallet/public RPC、hosted CI、G1〜G4は証拠が揃うまで未合格のまま維持する。
