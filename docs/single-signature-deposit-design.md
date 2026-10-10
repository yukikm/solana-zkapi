# 入金を1回の署名で完了するZKAPI本体の設計

2026-10-06 JST更新。状態：**本体・SDK・Indexerの実装とローカル実SBF検証を追加。公開配備・実Phantom受入は未実施。** 最新の実装・試験結果は[実装証跡](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-single-deposit-implementation.md)を正本とする。[ADR-0003](adr/0003-single-transaction-deposit.md)と、設計初版時点の[offline計測report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-single-deposit-transport-analysis.json)を併読する。以下の設計初版の数値と受入条件は保持する。

## 1. 結論と達成条件

**Vaultに `deposit_compact_v1` を追加し、重複を省いた入金データをv0取引1つで送る。SDKは既存のWalletClient・暗号化journalでこの経路を扱う。** 追加のtree回路、trusted relayer、ALT、署名の一括承認を必須にしない。画面の変更は本設計の実現条件ではない。

正常系の自己負担入金では、利用者のwallet署名要求1回、Ed25519署名1つ、financial transaction 1つ、finalized receipt 1つでUSDCをVaultに預ける。証明検証、Note作成、USDC転送、tree更新は一括で成功またはrollbackする。通信断後の照合は署名を追加要求しない。

「どのような競合・期限切れでも、生涯その入金に再署名を求めない」という保証は含めない。現在root・next note ID・expiryに結合した取引が確定拒否されたときは、内容を更新して再署名が必要になる。これは4段階の正常処理とは区別する。入金後のAPI認可・利用・精算にwallet取引署名を増やさない。

## 2. 現状と原因

- [Vaultの `deposit`](../programs/zkapi-vault/src/lib.rs) は既に存在し、[共通handler](../programs/zkapi-vault/src/handlers.rs) が資金移動と状態更新を原子的に実行する。
- [SDK transport](../packages/sdk/src/transport.ts) は `v0_buffer` のみを生成し、入金をcreate → append → seal → executeへ分ける。[WalletClient](../packages/sdk/src/wallet.ts) は各stepの確定を待って次を署名する。
- 既存depositは692-byte args（8-byte discriminator込み700 bytes）。共通Financial accountsとowner signer、CU limit・CU priceを含む自己負担v0取引は **1,263 bytes**。現在の1,232-byte制限を31 bytes超える。
- 内部に同じ値を繰り返し持つのが主な圧縮余地である。例：expected rootとtree公開入力1、note IDと公開入力3、金額と公開入力7。

Ethereumの固定参照版はETH付きdepositを1回呼ぶ。こちらの4回は元ZKAPIの承認要件を継承したものではない。Solana版では同じPoseidon/treeの意味を維持するため追加tree proofを使っているが、その証明の送信方法は改善できる。

v0の1,232-byte制限と取引の原子性は[Solana公式資料](https://solana.com/docs/core/transactions)を参照。v1の紹介が存在しても、本案は未検証のwallet/cluster対応を前提にせず、既存のv0署名経路を使う。

## 3. 入金専用のcompact wire

新しいAnchor命令名を **`deposit_compact_v1`** に固定する。既存 `deposit` のdiscriminator、692-byte args、buffer payloadの意味は変更しない。命令名のv1はwireのversionであり、Solana transaction versionやaccount layout versionではない。

argsの型と順序は以下。長さは **436 bytes**、discriminator込み **444 bytes**。可変長Vec、任意のpublic-input配列、圧縮楕円曲線点は導入しない。

| args内offset | field | bytes / encoding |
|---:|---|---|
| 0 | expected_id | 4 / u32 LE |
| 4 | expected_root | 32 / canonical Fr BE |
| 36 | expiry | 8 / u64 LE |
| 44 | commitment | 32 / canonical Fr BE |
| 76 | amount | 8 / u64 LE、micro-USDC |
| 84 | new_root | 32 / canonical Fr BE |
| 116 | new_leaf | 32 / canonical Fr BE |
| 148 | transition_tag | 32 / canonical Fr BE |
| 180 | tree_proof | 256 / 既存の非圧縮proof wire |

programはpoolのowner/PDA/layout/profileを検証した上で、そのPoolConfigの `vault_binding` とargsから、既存の全11公開入力を復元する。

| index | 復元値 |
|---:|---|
| 0 | 検証済みPoolConfig.vault_binding |
| 1 | args.expected_root |
| 2 | args.new_root |
| 3 | Fr(args.expected_id) |
| 4 | Fr(0) |
| 5 | args.new_leaf |
| 6 | args.commitment |
| 7 | Fr(args.amount) |
| 8 | Fr(args.expiry) |
| 9 | Fr(0)：deposit tree operation |
| 10 | args.transition_tag |

公開入力は検証から削除しない。**同じ11入力・同じproof・同じVKへ復元して検証する。** new_leafやtransition_tagをprogramでPoseidon再計算する変更も行わない。元のrequest/withdrawal回路、tree回路、PK/VK、Poseidon、hash/domain、note secret、整数会計、layout 2は維持する。

`crates/zkapi-layout2` に純粋なdecode/expandを置き、引数長の完全一致、canonical field、整数のゼロ拡張を検査して元の692-byte canonical depositを出力する。bindingは呼出側が検証したpoolから渡し、wireから任意指定させない。SDK側のcompressは元payloadの重複値・定数・manifest bindingがすべて一致する場合だけ変換する。不一致を省略によって隠してはいけない。`expand(compress(canonical)) == canonical` を固定vectorと生成proofで検証する。

## 4. VaultとIDLの変更

新入口は既存の **DepositAccounts（Financial + token_owner_signer）をそのまま使用**する。unused accountのpayer別名化、owner/payerの役割分離、既存IDL account順を保つ。account数削減や新しい資金処理handlerは初版の範囲に入れない。

処理順序は以下とする。

1. strict entrypointでdiscriminatorと444 bytesの完全一致を確認。trailing bytes、旧wireとの取り違えを拒否。
2. token_owner_signerとFinancial.token_ownerの同一性・署名、PoolConfigの正当性を既存関数で検証。
3. compact argsをcanonical depositへ展開。
4. 既存 `handlers::run(financial, Operation::Deposit, canonical)` を呼ぶ。
5. 共通処理がroot/next ID/expiry/amount/全11入力、固定VK、USDC mint/authority/source/vaultを検証し、Note作成・TransferChecked・tree/sequence/outstanding更新・既存eventを実行。

既存validatorを共用し、compact経路だけ署名・proof・token・PDA・pause検査を減らさない。正規wireへの展開で追加されるstack/heap/CUは実SBFで測定する。現行入金のCU記録を、新命令の測定値として使わない。

compiler-backed IDLの生成元、length guard、SDK codec、indexerを一緒に変更する。手編集IDLだけで対応済みにしない。公開のPool/Note/TreeState account layoutとevent layoutは変更しない。

## 5. 取引サイズと比較

計測は固定web3.jsとSDKのaccount導出を用い、署名領域、CU limit、非ゼロCU price、実際のv0 message/account indicesを含める。数値とsource hashの正本は[offline report](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-single-deposit-transport-analysis.json)。

| 方式 | 自己負担取引bytes | 判断 |
|---|---:|---|
| 現行canonical depositをそのままinline | 1,263 | 31 bytes超過 |
| compact deposit・同じaccounts・ALTなし | 1,007 | 本案。225 bytesの余裕 |
| compact・ownerと費用負担者を分離 | 1,103 | 署名2つ。利用者とサービスの役割を明示した場合のみ |
| compact・owner／Note rent payer／fee payerを全分離 | 1,199 | 署名3つ。33 bytesの余裕。追加命令を自由に入れない |

自己負担を通常経路にする。スポンサーを導入する場合も利用者の承認は自分の署名1回だが、transaction全体の署名数は2〜3になるので別に計測・表示する。SDKは全構成を実serializeし、1,232 bytes超過なら署名前に停止する。余裕を未審査のmemo/転送命令に使わない。

比較した代替案：

- **既存deposit + ALT**：proof/wireの変更を減らせる。共有addressを事前登録したALTでサイズが減るが、表の配備・固定・検証・availability・wallet/receipt復元が新しい依存になる。利用者にALT作成署名を要求すると目標を失う。初版はALT不要のcompactを選ぶ。[ALT公式資料](https://solana.com/developers/cookbook/transactions/lookup-tables)
- **account listだけ削る**：wireへの重複を残し、署名者やCU priceによる余裕も小さくなる。新しいaccount mappingの検証を増やすため、共通account contractを保つcompactを優先する。
- **4取引を一括署名**：承認画面数が減っても4取引のままで、途中状態・blockhash期限・復旧が残る。原子的な1取引入金という本目標を満たさない。
- **relayerがbufferを準備**：利用者の前半署名を代行する構成は可能性があるが、複数取引、service signer、rent、可用性の責任が増える。本案では不要。
- **v1だけに切替**：実cluster/RPC/walletの検証を前提とする別transport。今回のv0対応範囲から切り離す。

## 6. SDKの実行手順

1. `beginDeposit` が最初のfinalized snapshotから暫定note IDとexpiryを決め、既存proverでprivate witness/stateを作成する。note secret、金額、operation ID、認証済みcapabilityから選んだtransportを暗号化journalへ保存する。
2. 保存したwitness/stateとsnapshotに対し、既存proverでtree proofを生成・ローカル検証。compact変換前後の公開入力一致を確認する。重いtree proof生成・wallet署名・送信より先にwitnessをdurableにする。
3. 署名前にpool/root/next ID/expiryを再確認。未署名の段階で不整合が見つかれば同じsecret/amountのまま準備を更新できる。rootの予約や他ユーザーの排除とは扱わない。
4. proof生成後にfresh blockhashを取得。既存のpreparation commitment・preflight・fee上限を使い、取引内容を固定してwalletへ1回署名要求。
5. 既存 `signV0` でmessage不変と全署名を確認。exact signed bytesを暗号化CAS保存し、保存完了後だけ送信する。
6. exact messageに一致するfinalized receiptと、そのslot以降の実Note/commitment/amount/expiry/statusを照合して `active` にする。そこで既存ControlClientが利用可能になる。

SDKの型は `InlineDepositPlanRecord` / `InlineDepositAttempt` を既存のoperation/attempt unionへ追加する。inlineのために偽のbuffer/nonceや第2のnote state machineを作らない。`deposit_inline` はexecute/finalizeと同じfinancial terminal stepとして扱う。API層・Go clientd・browserは同じWalletClientを呼ぶ。

planにはtransport、deployment/program/pool/mint、全account/roles、discriminator、exact compact bytes、展開したcanonical payload/digest、amount/expected root/ID/expiry、snapshot slot/sequence、fee条件を保存する。attemptにはsigned message/wire、署名、blockhash、last-valid heightを保存する。`inlineInstructionDigest` と既存canonical payload digestは別名で記録し、既存bufferのdigest定義を変更しない。

inlineのroleは `tokenOwner`、Note作成費を負担するFinancialの `payer`、transactionの `feePayer` の3つに限定する。既存buffer用 `uploader` / `rentPayer` はinlineでは使わず、新planへ暗黙に引き継がない。既存APIのrole objectを受けるadapterはこの対応を明示し、曖昧な費用負担の指定を署名前に拒否する。

## 7. journalと未知送信の回復

新inline操作を含むNoteJournalのplaintext schemaを **2** とし、共有validatorは旧schema 1と新schema 2を明示的に検証する。暗号化envelope/AAD/CAS/lockは既存方式を維持する。schema 2ではtransportとplan/attemptの判別union、許可されたfield、exclusiveな構造、署名とwireの一貫性を検証する。旧SDKのschema 1限定validatorが新recordを拒否することを実テストで確認する。

新SDKは旧schema 1を読み、transport欠落を従来bufferとして扱う。旧recordは読み取りだけで書換えず、旧buffer操作を新inlineへ変換しない。schema 2のControlClient更新でもschemaを1へ戻すliteral生成を禁止し、全writerを検査する。既存buffer historyと旧署名・失敗記録を保持する。

| 観測結果 | 同じWalletClient内での動作 |
|---|---|
| 未署名／walletの署名拒否 | 未送信を保持。再開時だけ署名要求。送信0 |
| signed bytesの保存失敗／commit前crash | 送信0。journalを読み直し、commitがなければ未送信planから再署名できる。保存成功応答だけを失った場合は保存済みattemptを使う |
| finalized成功、exact message一致 | receipt slot以上のNoteを照合しactive化。CAS前crashなら同じ結果を再照合 |
| finalized StaleRoot/StaleNoteId/InvalidExpiry | 旧attemptを保存。同じoperation/secret/amountで新snapshotへ再prove。buffer closeは不要。新messageは明示再署名 |
| その他のfinalized拒否 | failedを保持。原因解消後、既存の明示retryRejected相当で再準備 |
| ACK喪失、confirmedのみ、履歴欠測、RPC不一致、期限切れのみ | unresolvedのまま。新deposit、新note IDへのrebase、bufferへの自動fallbackは禁止 |

回復は既存の署名観測・exact bytes検証を共用する。送信不明時に自動再送を追加せず、既存の明示的な同一bytes回復方針を維持する。金融命令に `reconcileExpiredCreation` や `refreshExpiredUpload` を適用してはいけない。buffer不在の証明は入金の不成立を示さない。

同じexpected IDの再実行は、next_note_idの単調増加とNote PDAの未使用条件で二重引落しを拒否する。ただしlocal operation UUIDはオンチェーンの冪等キーではない。未知送信を別ID/rootへrebaseすると旧新両方が成立し得るため、**正確な確定拒否を確認する前に新financial attemptを作らない**。

「障害・競合時も再承認なし」を別途目標にする場合は、note IDに依存しない署名intent、stable deposit nonce/receipt PDA、source/amount/pool/mint/deadline/commitmentのbindingとrelayerの再proof権限を別ADRで設計する。今回のcompact化に隠れて導入しない。

## 8. indexer・manifest・配備順序

- indexerの新discriminator対応はcompactを同じcanonical commandへ展開し、既存transition/event/root再構築を使う。bindingはその時点の検証済みpool configを使う。失敗transactionのlogを成功扱いせず、event欠落時もinstructionから再生する。
- 署名manifestの `transaction_formats` に **`v0_inline_deposit_v1`** を追加する。この値はdeposit_compact_v1だけを意味する。既存 `v0_inline` の意味を黙って変更しない。`v0_buffer` は全既存機能・退出・旧journalの互換経路として必須のまま残す。
- SDK/trust、OpenAPI生成元、native/Go/control/challengerのvalidator・配布pinを整合させる。circuit profileとaccount layoutは不変、IDL/ELF/配布物hashとmanifest hashは更新する。UIや未認証RPCが返す機能フラグで選択しない。
- 実装では、独立配布の `ManifestTrustPolicy.build.transactionFormats` に `v0_buffer` と `v0_inline_deposit_v1` の両方を要求する。署名manifestのcapabilityだけでは有効にしない。hash検証済みIDLのdiscriminator・引数・account rolesも一致させ、未解決操作の各入口で保存済みmanifest hashを再照合する。
- 初回canaryは隔離したdevnet program/poolと新journalを使う。既存の入金済みdemo、manifest pin、署名journal、稼働サービスは本設計作業で変更しない。
- 既存poolへ互換upgradeする場合は、indexer/読取側を先に配備し、旧命令と既存funded noteの復旧が維持されることを確認後にVaultをupgrade、新manifestを配布する。program/poolが変わる場合はbindingが変わるので既存noteを移植した扱いにしない。
- 新SDKは旧buffer-only manifestでも旧操作を回復できる。新manifestを理解しない旧SDKは停止し、機能を推測して送らない。未解決操作のtrust pinsを新manifestへ上書きする移行は禁止する。

ADR-0001の「v0_bufferを既定とする」は、検証完了後に**対応manifestの新規depositだけcompactを既定**にする補足へ更新する。他操作・旧journalのmandatory bufferは維持する。現在の設計契約や稼働manifestを本提案だけで有効化しない。

## 9. 実装タスクと受入条件

| 順序 | component / 変更箇所 | 完了条件 |
|---|---|---|
| D1 | crates/zkapi-layout2、packages/sdk/src/layout2.ts、wire契約 | 436-byte compactのstrict decode/expand、canonicalとのbyte一致。全field/定数/binding/境界の不正を拒否 |
| D2 | programs/zkapi-vault/src/{lib,handlers,accounts}.rs、tools/vault-idl、IDL guard | 共通handlerを呼ぶ新入口、compiler-backed IDL、444-byte length guard。実proof＋実SBFで原子性とCUを測定 |
| D3 | services/indexer/src/replay.rs、replay tests | buffer／従来inline／compact混在履歴、event欠落、失敗log、再起動で同じfinalized cut・root・sequence |
| D4 | packages/sdk/src/{transport,wallet,control,trust}.ts、journal validator | 1stepの金融plan、schema互換、immutable署名保存、未知結果の保持、stale/failedの明示回復 |
| D5 | work/design/generate_contracts.py、manifest/build pins、apps/clientd/runtime.ts、配布 | 新capabilityを署名・pin検証して選択。同じSDKでnative/browserが動作し、旧journalを維持 |
| D6 | tests/svm、SDK runtime、独立devnet collector | 実Phantom署名要求1回・送信1回・finalized取引1件、USDC/Note照合とcrash回復を独立記録 |

必須の安全性・互換性試験：

1. 正常入金で1件のfinancial instruction、署名1つ、取引<=1,232 bytes、既存上限<=1,000,000 CU。自己負担と独立payer構成を別計測。
2. compactの全field、pool binding、proof座標、公開入力を個別に改変して拒否。別の有効proofとの混合、old wire・trailing bytesも拒否。検査削除でサイズを達成しない。
3. USDC不足/frozen、偽mint/token program、別owner/source/PDA、pause、overflowでNote/root/sequence/outstanding/USDCが全部rollback。ネットワークfeeはrollback対象外。
4. 同じsigned bytes、同じpayload＋別blockhashの重複実行でも引落しは1回。root/ID/day-boundary競合後は確定拒否のある場合だけ再prove。
5. walletによるmessage/他署名改変、CAS失敗、二重tabを拒否。signed-attemptのdurable commit前crashでは送信0を確認し、失われたメモリー上の署名は未送信planから再取得できる。commit後・送信ACK喪失・receipt後CAS前のcrashではexact保存attemptだけで回復し、新入金・rebase・追加署名を発生させない。
6. history-pruned RPC、期限切れ＋Note不在、他人のNote、異なるreceipt、RPC不一致で新署名/rebase/fallbackを自動実行しない。
7. 新SDKで旧buffer journal、旧SDKでschema 2拒否、ControlClient更新時のschema 2維持、既存withdraw/escape/challengeを回帰。
8. 新program/IDL/capabilityの組合せ違いを署名前に拒否。新discriminatorを理解しない旧indexerが黙って飛ばさない。

設計初版のoffline取引serialize合格はD1〜D6の完了ではない。追加実装では新命令のCU・実proof受理をローカルSBFで検証し、D4の暗号化journalとD3の混在履歴も検証する。D6の実Phantom画面数・公開finality・全I10/G1〜G4は別の未完了gateとして記録する。ローカルfixtureでの署名・SBF資金処理を、利用者のwallet署名・公開chain送信・実資金移動と混同しない。今回の実装作業では稼働demoへの配備・サービス再起動・provider要求は行っていない。
